import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CoderVcsStatus, layer } from "./coderVcsStatus.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";

const status = (refName: string) => ({
  isRepo: true,
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
        { _tag: "snapshot", local: status("main") },
        { _tag: "localUpdated", local: status("feature") },
      ]);
    }),
  );
});
