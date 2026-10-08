import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { isCoderPullRequestLink } from "../coderPullRequestLink.ts";
import { createAgentMrBridge, type AgentMrRequest } from "./bridge.ts";

/**
 * The orchestration reads and commands the MR tools need. Bound after the orchestrator starts
 * because the orchestrator's turn start is what prepares the tools.
 */
export interface AgentMergeRequestsBackend {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, unknown>;
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, unknown>;
  readonly dispatch: (command: OrchestrationV2Command) => Effect.Effect<unknown, unknown>;
}

export interface AgentMergeRequestsShape {
  /** Returns the per-turn instructions, or nothing when the tools are unavailable. */
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly readOnly: boolean;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<string | undefined>;
  readonly release: (
    threadId: ThreadId,
    runId?: RunId,
    instanceId?: ProviderInstanceId,
  ) => Effect.Effect<void>;
  readonly bind: (backend: AgentMergeRequestsBackend) => Effect.Effect<void>;
}

/**
 * Coder: workspace MR commands for agents. Each turn gets a private request/reply directory and a
 * Node client script; there is no socket or MCP server. Upstream's orchestration has no such
 * tools, so the default is a no-op.
 */
export class AgentMergeRequests extends Context.Reference<AgentMergeRequestsShape>(
  "t3/AgentMergeRequests",
  {
    defaultValue: () => ({
      prepare: () => Effect.undefined,
      release: () => Effect.void,
      bind: () => Effect.void,
    }),
  },
) {}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export const make = Effect.gen(function* () {
  const backendRef = yield* Ref.make<AgentMergeRequestsBackend | undefined>(undefined);
  const entries = new Map<
    ThreadId,
    {
      bridge: Awaited<ReturnType<typeof createAgentMrBridge>>;
      readOnly: boolean;
      instanceId: ProviderInstanceId;
      runId: RunId;
    }
  >();

  const release = (threadId: ThreadId, runId?: RunId, instanceId?: ProviderInstanceId) =>
    Effect.promise(async () => {
      const entry = entries.get(threadId);
      if (!entry) return;
      if (instanceId !== undefined && instanceId !== entry.instanceId) return;
      if (runId !== undefined && entry.runId !== runId) return;
      entries.delete(threadId);
      await entry.bridge.close();
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries.keys()], (id) => release(id), { discard: true }),
  );

  const execute = (threadId: ThreadId, request: AgentMrRequest) =>
    Effect.gen(function* () {
      const backend = yield* Ref.get(backendRef);
      if (!backend) return yield* Effect.fail(new Error("MR tools are not ready."));
      const entry = entries.get(threadId);
      if (!entry) return yield* Effect.fail(new Error("Expired MR tools."));
      const thread = yield* backend.getThreadShell(threadId);
      if (thread === null || thread.archivedAt !== null) {
        return yield* Effect.fail(new Error("Thread unavailable."));
      }
      if (thread.activeRunId !== entry.runId) {
        return yield* Effect.fail(new Error("MR tools require the current active turn."));
      }
      const links = visibleThreadPullRequests(thread.pullRequests ?? []);
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
      if (entry.readOnly || thread.interactionMode === "plan")
        return yield* Effect.fail(new Error("Plan mode permits listing only."));
      const parsed = parseChangeRequestUrl(request.url ?? "");
      const projects = yield* backend.listProjects;
      if (!parsed || !isCoderPullRequestLink({ ...parsed, url: request.url! }, projects)) {
        return yield* Effect.fail(new Error("Invalid GitLab MR link."));
      }
      const existing = links.some(
        (link) => threadPullRequestKeyOf(link) === threadPullRequestKeyOf(parsed),
      );
      if (request.operation === "link") {
        if (!existing)
          yield* backend.dispatch({
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
        yield* backend.dispatch({
          type: "thread.pull-request.unlink",
          threadId,
          commandId: CommandId.make(`agent-mr:${request.id}`),
          ...parsed,
        });
      return { ...parsed, wasLinked: existing };
    });

  const prepareLock = Semaphore.makeUnsafe(1);
  const prepare: AgentMergeRequestsShape["prepare"] = ({ threadId, runId, readOnly, instanceId }) =>
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
          entry = { bridge, readOnly, instanceId, runId };
          entries.set(threadId, entry);
        }
        entry.readOnly = readOnly;
        entry.runId = runId;
        const command = `${quote(process.execPath)} ${quote(entry.bridge.script)}`;
        return `<t3_merge_requests>\nWorkspace MR tools for this thread: ${command} list${readOnly ? "" : `; ${command} link '<GitLab MR URL>'; ${command} unlink '<GitLab MR URL>'`}.\n${readOnly ? "Only listing is available in plan mode." : "After creating an MR with glab, link its URL here. These commands manage T3 thread associations only; they do not create, merge, or close GitLab MRs."}\nRun one command at a time. Use the current turn's command, not a path from an earlier turn. On timeout, list links before retrying.\n</t3_merge_requests>`;
      },
      catch: () => new Error("Workspace MR tools could not be prepared."),
    }).pipe(
      prepareLock.withPermits(1),
      Effect.catch(() =>
        Effect.logWarning("Workspace MR tools unavailable for this turn").pipe(
          Effect.as(undefined),
        ),
      ),
    );

  return {
    prepare,
    release,
    bind: (backend) => Ref.set(backendRef, backend),
  } satisfies AgentMergeRequestsShape;
});

export const layer = Layer.effect(AgentMergeRequests, make);
