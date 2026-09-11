import { CommandId, type ThreadId, type TurnId, type ProviderInstanceId } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { isCoderPullRequestLink } from "../coderPullRequestLink.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createAgentMrBridge, type AgentMrRequest } from "./bridge.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export class AgentMergeRequests extends Context.Service<
  AgentMergeRequests,
  {
    readonly prepare: (
      threadId: ThreadId,
      readOnly: boolean,
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<string, Error>;
    readonly activate: (threadId: ThreadId, turnId: TurnId) => void;
    readonly release: (
      threadId: ThreadId,
      turnId?: TurnId,
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<void>;
  }
>()("t3/AgentMergeRequests") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const entries = new Map<
    ThreadId,
    {
      bridge: Awaited<ReturnType<typeof createAgentMrBridge>>;
      readOnly: boolean;
      instanceId?: ProviderInstanceId;
      turnId?: TurnId;
    }
  >();

  const release = (threadId: ThreadId, turnId?: TurnId, instanceId?: ProviderInstanceId) =>
    Effect.promise(async () => {
      const entry = entries.get(threadId);
      if (
        instanceId !== undefined &&
        entry?.instanceId !== undefined &&
        instanceId !== entry.instanceId
      )
        return;
      if (!entry || (turnId !== undefined && entry.turnId !== undefined && entry.turnId !== turnId))
        return;
      entries.delete(threadId);
      await entry.bridge.close();
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries.keys()], (id) => release(id), { discard: true }),
  );

  const execute = (threadId: ThreadId, request: AgentMrRequest) =>
    Effect.gen(function* () {
      const entry = entries.get(threadId);
      if (!entry) return yield* Effect.fail(new Error("Expired MR tools."));
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread) || thread.value.archivedAt !== null) {
        return yield* Effect.fail(new Error("Thread unavailable."));
      }
      if (entry.turnId !== undefined && thread.value.session?.activeTurnId !== entry.turnId) {
        return yield* Effect.fail(new Error("MR tools require the current active turn."));
      }
      const links = visibleThreadPullRequests(thread.value.pullRequests);
      if (request.operation === "list") {
        return {
          mergeRequests: links.map(({ host, repository, number, url, source, snapshot }) => ({
            host,
            repository,
            number,
            url,
            source,
            state: snapshot?.state ?? null,
            title: snapshot?.title ?? null,
            headBranch: snapshot?.headBranch ?? null,
            baseBranch: snapshot?.baseBranch ?? null,
          })),
          chains: resolveThreadPullRequestChains(links).map((chain) => ({
            kind: chain.kind,
            mergeRequests: chain.layers.map(({ host, repository, number }) => ({
              host,
              repository,
              number,
            })),
          })),
        };
      }
      if (entry.readOnly || thread.value.interactionMode === "plan")
        return yield* Effect.fail(new Error("Plan mode permits listing only."));
      const parsed = parseChangeRequestUrl(request.url ?? "");
      const snapshot = yield* snapshots.getShellSnapshot();
      if (!parsed || !isCoderPullRequestLink({ ...parsed, url: request.url! }, snapshot.projects)) {
        return yield* Effect.fail(new Error("Invalid GitLab MR link."));
      }
      const existing = links.some(
        (link) => threadPullRequestKeyOf(link) === threadPullRequestKeyOf(parsed),
      );
      if (request.operation === "link") {
        if (!existing)
          yield* engine.dispatch({
            type: "thread.pull-request.link",
            threadId,
            commandId: CommandId.make(`agent-mr:${request.id}`),
            ...parsed,
            url: request.url!,
            source: "agent",
          });
        return { ...parsed, alreadyLinked: existing };
      }
      if (existing)
        yield* engine.dispatch({
          type: "thread.pull-request.unlink",
          threadId,
          commandId: CommandId.make(`agent-mr:${request.id}`),
          ...parsed,
        });
      return { ...parsed, wasLinked: existing };
    });

  const prepareLock = Semaphore.makeUnsafe(1);
  const prepare = (threadId: ThreadId, readOnly: boolean, instanceId?: ProviderInstanceId) =>
    Effect.tryPromise({
      try: async () => {
        let entry = entries.get(threadId);
        if (entry && entry.instanceId !== instanceId) {
          await Effect.runPromise(release(threadId));
          entry = undefined;
        }
        if (!entry) {
          if (entries.size >= 64) throw new Error("Too many active MR tool sessions.");
          const bridge = await createAgentMrBridge((request, signal) =>
            Effect.runPromise(execute(threadId, request), { signal }),
          );
          entry = { bridge, readOnly, ...(instanceId === undefined ? {} : { instanceId }) };
          entries.set(threadId, entry);
        }
        entry.readOnly = readOnly;
        const command = `${quote(process.execPath)} ${quote(entry.bridge.script)}`;
        return `<t3_merge_requests>\nWorkspace MR tools for this thread: ${command} list${readOnly ? "" : `; ${command} link '<GitLab MR URL>'; ${command} unlink '<GitLab MR URL>'`}.\n${readOnly ? "Only listing is available in plan mode." : "After creating an MR with glab, link its URL here. These commands manage T3 thread associations only; they do not create, merge, or close GitLab MRs."}\nRun one command at a time. Use the current turn's command, not a path from an earlier turn. On timeout, list links before retrying.\n</t3_merge_requests>`;
      },
      catch: () => new Error("Workspace MR tools could not be prepared."),
    }).pipe(prepareLock.withPermits(1));
  return {
    prepare,
    release,
    activate: (threadId, turnId) => {
      const entry = entries.get(threadId);
      if (entry) entry.turnId = turnId;
    },
  } satisfies AgentMergeRequests["Service"];
});
export const layer = Layer.effect(AgentMergeRequests, make);
