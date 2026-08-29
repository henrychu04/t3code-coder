import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { CoderVcsStatus, layer } from "./coderVcsStatus.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
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
  it.effect("retains changes published while the initial snapshot is loading", () =>
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
        yield* vcsStatus.refresh("/repo");
        yield* Deferred.succeed(finishSnapshot, undefined);
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
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            automaticGitFetchInterval: Duration.seconds(5),
          }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const vcsStatus = yield* CoderVcsStatus;
      const eventsFiber = yield* vcsStatus.stream("/repo").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(remoteReads).toBe(1);
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
});
