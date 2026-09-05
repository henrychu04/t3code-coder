import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  type OrchestrationProject,
} from "@t3tools/contracts";

import { CoderVcsStatus, layer } from "./coderVcsStatus.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "./serverSettings.ts";

const status = (refName: string) => ({
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: refName === "main",
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

describe("CoderVcsStatus", () => {
  it.effect("automatically pulls an enabled clean default branch when it is behind", () => {
    let pullCalls = 0;
    let remoteReads = 0;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: () => Effect.succeed(status("main")),
          remoteStatus: () =>
            Effect.sync(() => ({
              hasUpstream: true,
              aheadCount: 0,
              behindCount: remoteReads++ === 0 ? 2 : 0,
              pr: null,
            })),
          pull: () =>
            Effect.sync(() => {
              pullCalls += 1;
              return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getActiveProjectByWorkspaceRoot: () =>
            Effect.succeed(Option.some({ autoPull: true } as OrchestrationProject)),
        }),
      ),
    );

    return Effect.gen(function* () {
      const vcsStatus = yield* CoderVcsStatus;
      yield* vcsStatus.refresh("/repo");
      expect(pullCalls).toBe(1);
      expect(remoteReads).toBe(2);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("serializes an explicit refresh behind the initial snapshot", () =>
    Effect.gen(function* () {
      const snapshotStarted = yield* Deferred.make<void>();
      const finishSnapshot = yield* Deferred.make<void>();
      let reads = 0;
      const testLayer = layer.pipe(
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            invalidateStatus: () => Effect.void,
            localStatus: () => {
              reads += 1;
              if (reads === 1) {
                return Deferred.succeed(snapshotStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(finishSnapshot)),
                  Effect.as(status("main")),
                );
              }
              return Effect.succeed(status("feature"));
            },
            remoteStatus: () => Effect.succeed(null),
          }),
        ),
      );

      const events = yield* Effect.gen(function* () {
        const vcsStatus = yield* CoderVcsStatus;
        const streamFiber = yield* vcsStatus
          .stream("/repo")
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Deferred.await(snapshotStarted);
        const refresh = yield* vcsStatus.refresh("/repo").pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.zero);
        expect(reads).toBe(1);
        yield* Deferred.succeed(finishSnapshot, undefined);
        yield* Fiber.join(refresh);
        return yield* Fiber.join(streamFiber);
      }).pipe(Effect.provide(testLayer));

      expect(Array.from(events)).toEqual([
        { _tag: "snapshot", local: status("main"), remote: null },
        { _tag: "localUpdated", local: status("feature") },
      ]);
    }),
  );

  it.effect("polls Git status at the configured interval", () => {
    let remoteReads = 0;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: () => Effect.succeed(status("main")),
          remoteStatus: () =>
            Effect.sync(() => {
              remoteReads += 1;
              return null;
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ServerSettings.ServerSettingsService)({
          subscribeChanges: Effect.succeed(Stream.empty),
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            automaticGitFetchInterval: Duration.seconds(5),
          }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const vcsStatus = yield* CoderVcsStatus;
      const eventsFiber = yield* vcsStatus
        .stream("/repo")
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      expect(remoteReads).toBe(1);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      yield* TestClock.adjust(Duration.seconds(5));
      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(events.map((event) => event._tag)).toEqual([
        "snapshot",
        "localUpdated",
        "remoteUpdated",
      ]);
      expect(remoteReads).toBe(2);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("keeps polling after a transient Git failure", () => {
    let remoteReads = 0;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: () => Effect.succeed(status("main")),
          remoteStatus: () => {
            remoteReads += 1;
            return remoteReads === 2
              ? Effect.fail(
                  new GitCommandError({
                    operation: "test.poll",
                    command: "git",
                    cwd: "/repo",
                    detail: "Transient upstream failure.",
                  }),
                )
              : Effect.succeed(null);
          },
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ServerSettings.ServerSettingsService)({
          subscribeChanges: Effect.succeed(Stream.empty),
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            automaticGitFetchInterval: Duration.seconds(5),
          }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const vcsStatus = yield* CoderVcsStatus;
      const eventsFiber = yield* vcsStatus
        .stream("/repo")
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Effect.yieldNow;
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      yield* TestClock.adjust(Duration.seconds(5));
      const events = Array.from(yield* Fiber.join(eventsFiber));

      expect(events.map((event) => event._tag)).toEqual([
        "snapshot",
        "localUpdated",
        "remoteUpdated",
      ]);
      expect(remoteReads).toBe(3);
    }).pipe(Effect.provide(testLayer));
  });
});

it.effect(
  "shares polling across subscribers, applies interval changes, and stops after unsubscribe",
  () =>
    Effect.gen(function* () {
      const settings = yield* SubscriptionRef.make({
        ...DEFAULT_SERVER_SETTINGS,
        automaticGitFetchInterval: Duration.zero,
      });
      let reads = 0;
      const testLayer = layer.pipe(
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            invalidateStatus: () => Effect.void,
            localStatus: () => Effect.succeed(status("main")),
            remoteStatus: () =>
              Effect.sync(() => {
                reads++;
                return null;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: SubscriptionRef.get(settings),
            subscribeChanges: Effect.succeed(SubscriptionRef.changes(settings)),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const vcs = yield* CoderVcsStatus;
        const first = yield* vcs.stream("/repo").pipe(Stream.runDrain, Effect.forkChild);
        const second = yield* vcs.stream("/repo").pipe(Stream.runDrain, Effect.forkChild);
        const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
        yield* settle;
        expect(reads).toBe(2);
        yield* TestClock.adjust(Duration.seconds(10));
        expect(reads).toBe(2);
        yield* SubscriptionRef.update(settings, (value) => ({
          ...value,
          automaticGitFetchInterval: Duration.seconds(2),
        }));
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(2));
        expect(reads).toBe(3);
        yield* Fiber.interrupt(first);
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(2));
        expect(reads).toBe(4);
        yield* Fiber.interrupt(second);
        yield* TestClock.adjust(Duration.seconds(10));
        expect(reads).toBe(4);
      }).pipe(Effect.provide(testLayer));
    }),
);

it.effect("local refresh neither fetches nor automatically pulls", () => {
  const fetches: boolean[] = [];
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        invalidateStatus: () => Effect.void,
        localStatus: () => Effect.succeed(status("main")),
        remoteStatus: (_input, options) =>
          Effect.sync(() => {
            fetches.push(options?.fetch ?? false);
            return { hasUpstream: true, aheadCount: 0, behindCount: 2, pr: null };
          }),
        pull: () => Effect.die("A local refresh must not pull"),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(Option.some({ autoPull: true } as OrchestrationProject)),
      }),
    ),
  );
  return Effect.gen(function* () {
    const vcs = yield* CoderVcsStatus;
    yield* vcs.refresh("/repo", { fetch: false });
    expect(fetches).toEqual([false]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("serializes automatic pulls for concurrent refreshes of the same repository", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    let active = 0;
    let maximum = 0;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: () => Effect.succeed(status("main")),
          remoteStatus: () =>
            Effect.succeed({ hasUpstream: true, aheadCount: 0, behindCount: 1, pr: null }),
          pull: () =>
            Effect.gen(function* () {
              maximum = Math.max(maximum, ++active);
              yield* Deferred.await(release);
              active--;
              return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getActiveProjectByWorkspaceRoot: () =>
            Effect.succeed(Option.some({ autoPull: true } as OrchestrationProject)),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const vcs = yield* CoderVcsStatus;
      const requests = yield* Effect.all([vcs.refresh("/repo"), vcs.refresh("/repo")], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(requests);
      expect(maximum).toBe(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("does not publish an older refresh after a newer refresh", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    let reads = 0;
    const observed: string[] = [];
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: () => {
            const index = reads++;
            return index === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(status("old")),
                )
              : Effect.succeed(status(index === 0 ? "initial" : "new"));
          },
          remoteStatus: () => Effect.succeed(null),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const vcs = yield* CoderVcsStatus;
      const observer = yield* vcs.stream("/repo").pipe(
        Stream.runForEach((event) => {
          if ("local" in event) observed.push(event.local.refName!);
          return Deferred.succeed(ready, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      const old = yield* vcs.refresh("/repo").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const newer = yield* vcs.refresh("/repo").pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(old);
      yield* Fiber.join(newer);
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);
      yield* Fiber.interrupt(observer);
      expect(observed.at(-1)).toBe("new");
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("keeps repositories independent and releases the permit after cancellation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let blockFirstRead = true;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          invalidateStatus: () => Effect.void,
          localStatus: ({ cwd }) => {
            if (cwd === "/repo" && blockFirstRead) {
              blockFirstRead = false;
              return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
            }
            return Effect.succeed(status(cwd));
          },
          remoteStatus: () => Effect.succeed(null),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const vcs = yield* CoderVcsStatus;
      const blocked = yield* vcs.refresh("/repo").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect((yield* vcs.refresh("/other")).refName).toBe("/other");
      yield* Fiber.interrupt(blocked);
      expect((yield* vcs.refresh("/repo")).refName).toBe("/repo");
    }).pipe(Effect.provide(testLayer));
  }),
);
