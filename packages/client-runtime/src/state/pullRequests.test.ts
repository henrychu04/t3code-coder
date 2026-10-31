import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Deferred from "effect/Deferred";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
} from "./pullRequests.ts";
import { executeAtomQuery } from "./runtime.ts";

class MutationRefused extends Data.TaggedError("MutationRefused") {}

// Coder: one connection target; upstream's cross-environment routing tests (shared probes,
// alternates, routed viewed marks and writes) are not carried with that routing.
const TARGET = new ConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry };
});

it.effect("keeps concurrent diff file reads on different hosts separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Latch.make();
      const started = yield* Latch.make();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsDiffFileContents]: (input: { readonly host: string }) =>
          Effect.gen(function* () {
            calls.push(input.host);
            yield* started.open;
            yield* release.await;
            return { oldContents: "", newContents: input.host };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const input = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        changeType: "change",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
      } as const;
      const first = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.com" },
      });
      yield* started.await;
      const second = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.example.com" },
      });
      yield* release.open;

      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results).toMatchObject([
        { _tag: "Success", value: { newContents: "github.com" } },
        { _tag: "Success", value: { newContents: "github.example.com" } },
      ]);
      expect(calls).toEqual(["github.com", "github.example.com"]);
    }),
  ),
);

it.effect.each(["closed", "draft", "permission", "stack", "method"] as const)(
  "rejects an unsafe quick merge with %s and keeps later actions running",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.succeed({
              state: reason === "closed" ? "closed" : "open",
              isDraft: reason === "draft",
              capabilities: { actions: ["merge"], stackActions: true },
              viewerPermissions: { actions: reason === "permission" ? [] : ["merge"] },
            }),
          [WS_METHODS.pullRequestsStack]: () => Effect.succeed(reason === "stack" ? {} : null),
          [WS_METHODS.pullRequestsRunAction]: (input: { action: string }) =>
            Effect.sync(() => calls.push(input.action)),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = {
          environmentId: TARGET.environmentId,
          input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
        };
        const merge = atoms.runAction.run(registry, {
          ...target,
          input: {
            ...target.input,
            action: "merge",
            resolveMergeMethod: () => {
              if (reason === "method") throw new Error("No merge method is available.");
              return "squash";
            },
          },
        });
        const close = atoms.runAction.run(registry, {
          ...target,
          input: { ...target.input, action: "close" },
        });
        const results = yield* Effect.promise(() => Promise.all([merge, close]));
        expect(results.map((result) => result._tag)).toEqual(["Failure", "Success"]);
        expect(calls).toEqual(["close"]);
      }),
    ),
);

it.effect("keeps a close batch ordered and continues after a refused close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: number[] = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsRunAction]: (input: { number: number; action: string }) =>
          Effect.gen(function* () {
            expect(input.action).toBe("close");
            calls.push(input.number);
            if (input.number === 6) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            if (input.number === 5)
              return yield* new PullRequestOperationError({
                operation: "runAction",
                detail: "You cannot close this pull request.",
              });
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const batch = [6, 5, 4].map((number) =>
        atoms.runAction.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number,
            action: "close",
          },
        }),
      );
      yield* Deferred.await(started);
      expect(calls).toEqual([6]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all(batch));
      expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Success"]);
      expect(calls).toEqual([6, 5, 4]);
    }),
  ),
);

it.effect("keeps hover previews fresh after edits and turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let title = "Original title";
      let reads = 0;
      const read = (input: unknown) =>
        Effect.sync(() => {
          expect(input).toEqual(reference);
          reads++;
          return { ...reference, title };
        });
      const reference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        host: "github.example.com",
      };
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsPreview]: read,
        [WS_METHODS.pullRequestsDetail]: read,
        [WS_METHODS.pullRequestsUpdate]: (input: { title: string }) =>
          Effect.sync(() => {
            title = input.title;
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            title = "Closed";
          }),
        [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: reference };
      const preview = atoms.preview(target);
      const unmount = registry.mount(preview);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe(title);
      yield* Effect.promise(() => executeAtomQuery(registry, preview));
      expect(reads).toBe(1);
      const edited = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...reference, title: "Edited" } }),
      );
      expect(AsyncResult.isSuccess(edited)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Edited");
      yield* Effect.promise(() =>
        atoms.runAction.run(registry, { ...target, input: { ...reference, action: "close" } }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Closed");
      title = "Refreshed";
      yield* Effect.promise(() =>
        atoms.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: { reference },
        }),
      );
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).title,
      ).toBe("Refreshed");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(preview, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.title === "After turn")
          refreshed.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      title = "After turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;
    }),
  ),
);

it.effect("shares one refresh stream between independently created pull request readers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let subscriptions = 0;
      let title = "Original title";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          Stream.unwrap(
            Effect.sync(() => {
              subscriptions++;
              return SubscriptionRef.changes(revision);
            }),
          ),
        [WS_METHODS.pullRequestsSummary]: () => Effect.sync(() => ({ title, state: "open" })),
        [WS_METHODS.pullRequestsDetail]: () => Effect.sync(() => ({ title, state: "open" })),
      } as unknown as WsRpcProtocolClient;
      const { runtime, atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const summary = createLinkedPullRequestSummaryAtomFamily(runtime)(target);
      const detail = atoms.detail(target);
      for (const atom of [summary, detail]) {
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        expect((yield* AtomRegistry.getResult(registry, atom)).title).toBe(title);
      }
      yield* AtomRegistry.getResult(
        registry,
        atoms.refreshes({ environmentId: target.environmentId, input: {} }),
      );
      expect(subscriptions).toBe(1);

      const changed = [summary, detail].map((atom) => {
        const ready = Latch.makeUnsafe();
        const stop = registry.subscribe(atom, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.title === "Updated title") {
            ready.openUnsafe();
          }
        });
        return { ready, stop };
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => changed.forEach(({ stop }) => stop())));
      title = "Updated title";
      yield* SubscriptionRef.update(revision, (value) => value + 1);
      for (const { ready } of changed) yield* ready.await;
      expect(subscriptions).toBe(1);
    }),
  ),
);

it.effect("shares close, reopen, and merge with an untouched client's mounted PR readers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let state: "open" | "closed" | "merged" = "open";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => SubscriptionRef.changes(revision),
        [WS_METHODS.pullRequestsSummary]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsDetail]: () => Effect.sync(() => ({ state })),
        [WS_METHODS.pullRequestsList]: () =>
          Effect.sync(() => ({ entries: [{ number: 1, state }] })),
        [WS_METHODS.pullRequestsRunAction]: (input: {
          readonly action: "close" | "reopen" | "merge";
        }) =>
          Effect.gen(function* () {
            state =
              input.action === "close" ? "closed" : input.action === "merge" ? "merged" : "open";
            yield* SubscriptionRef.update(revision, (value) => value + 1);
          }),
      } as unknown as WsRpcProtocolClient;
      const writer = yield* makeTestRuntime(client);
      const reader = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.example.com",
          repository: "acme/web",
          number: 1,
        },
      };
      const detail = reader.atoms.detail(target);
      const summary = createLinkedPullRequestSummaryAtomFamily(
        reader.runtime,
        reader.atoms.refreshes,
      )(target);
      const list = reader.atoms.list({
        environmentId: TARGET.environmentId,
        input: { state: "all" },
      });
      const unmountDetail = reader.registry.mount(detail);
      const unmountSummary = reader.registry.mount(summary);
      const unmountList = reader.registry.mount(list);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmountDetail();
          unmountSummary();
          unmountList();
        }),
      );
      expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe("open");
      expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe("open");

      for (const [action, expected] of [
        ["close", "closed"],
        ["reopen", "open"],
        ["merge", "merged"],
      ] as const) {
        const detailChanged = Latch.makeUnsafe();
        const summaryChanged = Latch.makeUnsafe();
        const listChanged = Latch.makeUnsafe();
        const stops = [
          reader.registry.subscribe(detail, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              detailChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(summary, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.state === expected) {
              summaryChanged.openUnsafe();
            }
          }),
          reader.registry.subscribe(list, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.entries[0]?.state === expected) {
              listChanged.openUnsafe();
            }
          }),
        ];
        yield* Effect.addFinalizer(() => Effect.sync(() => stops.forEach((stop) => stop())));
        const result = yield* Effect.promise(() =>
          writer.atoms.runAction.run(writer.registry, {
            ...target,
            input: { ...target.input, action },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        yield* detailChanged.await;
        yield* summaryChanged.await;
        yield* listChanged.await;
        expect((yield* AtomRegistry.getResult(reader.registry, detail)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, summary)).state).toBe(expected);
        expect((yield* AtomRegistry.getResult(reader.registry, list)).entries[0]?.state).toBe(
          expected,
        );
        stops.forEach((stop) => stop());
      }
    }),
  ),
);

it.effect("shares checks reads across reference property order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsChecks]: () =>
          Effect.sync(() => {
            reads += 1;
            return { state: "open", checks: [], observedAt: 1_000 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const projectId = ProjectId.make("project-1");
      const row = atoms.checks({
        environmentId: TARGET.environmentId,
        input: { host: "github.com", repository: "acme/web", number: 1, projectId },
      });
      const panel = atoms.checks({
        environmentId: TARGET.environmentId,
        input: { projectId, host: "github.com", repository: "acme/web", number: 1 },
      });
      yield* AtomRegistry.getResult(registry, row);
      yield* AtomRegistry.getResult(registry, panel);
      expect(reads).toBe(1);
    }),
  ),
);

it.effect("keeps live detail reads separate from reads that allow stale data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: (input: { allowStale?: boolean }) =>
          Effect.succeed({ title: input.allowStale === false ? "latest checks" : "cached checks" }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const cached = atoms.detail(target);
      const live = atoms.detail({ ...target, input: { ...target.input, allowStale: false } });
      expect((yield* AtomRegistry.getResult(registry, cached)).title).toBe("cached checks");
      expect((yield* AtomRegistry.getResult(registry, live)).title).toBe("latest checks");
    }),
  ),
);

it.effect("updates cached labels after successful edits without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let detailReads = 0;
      let candidateReads = 0;
      let refuse = false;
      let failDetail = false;
      const existing = { name: "existing", color: "111111" };
      const addedLabel = { name: "new", color: "abcdef" };
      const detailRefreshStarted = yield* Latch.make();
      const releaseDetailRefresh = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            detailReads++;
            if (failDetail) {
              yield* detailRefreshStarted.open;
              yield* releaseDetailRefresh.await;
              return yield* new MutationRefused();
            }
            return { title: "keep this title", labels: [existing] };
          }),
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.sync(() => {
            candidateReads++;
            return {
              candidates: [
                { ...existing, description: null, isApplied: true },
                { ...addedLabel, description: "description", isApplied: false },
              ],
              truncated: false,
            };
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          refuse ? Effect.fail(new MutationRefused()) : Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const candidates = atoms.labelCandidates(target);
      registry.mount(detail);
      const unmountCandidates = registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });

      const added = yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...target,
          input: {
            host: target.input.host,
            projectId: target.input.projectId,
            repository: target.input.repository,
            number: target.input.number,
            labels: ["new"],
            applied: true,
          },
        }),
      );
      expect(AsyncResult.isSuccess(added)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, detail)).toEqual({
        title: "keep this title",
        labels: [existing, addedLabel],
      });
      unmountCandidates();
      registry.mount(atoms.labelCandidates(target));
      expect((yield* AtomRegistry.getResult(registry, candidates)).candidates[1]).toEqual({
        ...addedLabel,
        description: "description",
        isApplied: true,
      });

      for (const name of ["existing", "new"]) {
        refuse = name === "new";
        const result = yield* Effect.promise(() =>
          atoms.setLabels.run(registry, {
            ...target,
            input: { ...target.input, labels: [name], applied: false },
          }),
        );
        expect(result._tag).toBe(refuse ? "Failure" : "Success");
        expect((yield* AtomRegistry.getResult(registry, detail)).labels).toEqual([addedLabel]);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { name: "existing", isApplied: false },
          { name: "new", isApplied: true },
        ]);
      }
      expect(detailReads).toBe(1);
      expect(candidateReads).toBe(1);

      failDetail = true;
      registry.refresh(detail);
      yield* detailRefreshStarted.await;
      expect(registry.get(detail).waiting).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(detail)).labels).toEqual([addedLabel]);
      yield* releaseDetailRefresh.open;
      yield* Effect.exit(AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true }));
      expect(AsyncResult.isFailure(registry.get(detail))).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(detail)).labels).toEqual([addedLabel]);
      failDetail = false;
      registry.refresh(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).labels,
      ).toEqual([existing]);
      expect(detailReads).toBe(3);
    }),
  ),
);

it.effect("publishes the accepted guide run before the follow-up read finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accepted = {
        guide: null,
        currentHeadSha: "head",
        run: { _tag: "Running" as const, headSha: "head", startedAt: "2026-10-11T00:00:00.000Z" },
      };
      let reads = 0;
      const refreshStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsReviewGuide]: () =>
          Effect.gen(function* () {
            if (++reads > 1) {
              yield* refreshStarted.open;
              return yield* Effect.never;
            }
            return { guide: null, run: null, currentHeadSha: "head" };
          }),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: () => Effect.succeed(accepted),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
      };
      const query = atoms.reviewGuide(target);
      registry.mount(query);
      yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      const result = yield* Effect.promise(() => atoms.generateReviewGuide.run(registry, target));
      expect(result._tag).toBe("Success");
      yield* refreshStarted.await;
      expect(AsyncResult.getOrElse(registry.get(query), () => null)).toEqual(accepted);
    }),
  ),
);
