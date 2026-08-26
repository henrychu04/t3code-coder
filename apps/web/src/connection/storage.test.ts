import {
  EnvironmentId,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { connectionStorageLayer } from "./storage.ts";

const snapshot = (threadId: string, title: string): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: 1,
    thread: { id: ThreadId.make(threadId), title },
  }) as OrchestrationThreadDetailSnapshot;

const runWithCache = <A, E>(effect: Effect.Effect<A, E, EnvironmentCacheStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(connectionStorageLayer)));

describe("connection thread cache", () => {
  it("isolates delimiter-like environment and thread identifiers", async () => {
    const environmentA = EnvironmentId.make("storage-a\0b");
    const environmentB = EnvironmentId.make("storage-a");
    const first = snapshot("storage-c", "first");
    const second = snapshot("b\0storage-c", "second");

    await runWithCache(
      Effect.gen(function* () {
        const cache = yield* EnvironmentCacheStore;
        yield* cache.saveThread(environmentA, first);
        yield* cache.saveThread(environmentB, second);

        expect(Option.getOrThrow(yield* cache.loadThread(environmentA, first.thread.id))).toBe(
          first,
        );
        expect(Option.getOrThrow(yield* cache.loadThread(environmentB, second.thread.id))).toBe(
          second,
        );
        yield* cache.clear(environmentA);
        yield* cache.clear(environmentB);
      }),
    );
  });

  it("evicts by least-recently-used order and clears one environment only", async () => {
    const environment = EnvironmentId.make("storage-lru");
    const otherEnvironment = EnvironmentId.make("storage-other");
    const snapshots = Array.from({ length: 25 }, (_, index) =>
      snapshot(`storage-thread-${index}`, `Thread ${index}`),
    );
    const other = snapshot("storage-other-thread", "Other");

    await runWithCache(
      Effect.gen(function* () {
        const cache = yield* EnvironmentCacheStore;
        for (const value of snapshots.slice(0, 24)) {
          yield* cache.saveThread(environment, value);
        }
        yield* cache.loadThread(environment, snapshots[0]!.thread.id);
        yield* cache.saveThread(environment, snapshots[24]!);

        expect(Option.isSome(yield* cache.loadThread(environment, snapshots[0]!.thread.id))).toBe(
          true,
        );
        expect(Option.isNone(yield* cache.loadThread(environment, snapshots[1]!.thread.id))).toBe(
          true,
        );

        yield* cache.saveThread(otherEnvironment, other);
        yield* cache.clear(environment);
        expect(Option.isNone(yield* cache.loadThread(environment, snapshots[0]!.thread.id))).toBe(
          true,
        );
        expect(Option.getOrThrow(yield* cache.loadThread(otherEnvironment, other.thread.id))).toBe(
          other,
        );
        yield* cache.clear(otherEnvironment);
      }),
    );
  });
});
