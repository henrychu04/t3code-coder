import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makeSynchronizationCompletion } from "./synchronizationCompletion.ts";

describe("synchronization completion", () => {
  it.effect("runs the timeout action only while completion is outstanding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timeoutCount = yield* Ref.make(0);
        const completion = yield* makeSynchronizationCompletion({
          onTimeout: Ref.update(timeoutCount, (count) => count + 1),
        });

        yield* completion.startWaiting;
        yield* completion.arm;
        yield* TestClock.adjust("15 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(1);

        yield* completion.startWaiting;
        yield* completion.arm;
        yield* completion.stop;
        yield* TestClock.adjust("15 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(1);
      }),
    ),
  );

  it.effect("supersedes an older deadline as soon as a new attempt starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timeoutCount = yield* Ref.make(0);
        const completion = yield* makeSynchronizationCompletion({
          onTimeout: Ref.update(timeoutCount, (count) => count + 1),
        });

        yield* completion.startWaiting;
        yield* completion.arm;
        yield* TestClock.adjust("10 seconds");
        yield* completion.startWaiting;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(0);

        yield* completion.arm;
        yield* TestClock.adjust("15 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(1);
      }),
    ),
  );

  it.effect("replaces an armed deadline instead of retaining both timers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timeoutCount = yield* Ref.make(0);
        const completion = yield* makeSynchronizationCompletion({
          onTimeout: Ref.update(timeoutCount, (count) => count + 1),
        });

        yield* completion.startWaiting;
        yield* completion.arm;
        yield* TestClock.adjust("10 seconds");
        yield* completion.arm;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(0);

        yield* TestClock.adjust("10 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(1);
      }),
    ),
  );

  it.effect("does not arm a deadline while completion is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timeoutCount = yield* Ref.make(0);
        const completion = yield* makeSynchronizationCompletion({
          onTimeout: Ref.update(timeoutCount, (count) => count + 1),
        });

        yield* completion.arm;
        yield* TestClock.adjust("15 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(timeoutCount)).toBe(0);
      }),
    ),
  );

  it.effect("interrupts an active timeout action when completion stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = Latch.makeUnsafe();
        const interrupted = Latch.makeUnsafe();
        const completion = yield* makeSynchronizationCompletion({
          onTimeout: started.open.pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => interrupted.open.pipe(Effect.asVoid)),
          ),
        });

        yield* completion.startWaiting;
        yield* completion.arm;
        yield* TestClock.adjust("15 seconds");
        yield* started.await;
        yield* completion.stop;
        yield* interrupted.await;
        expect(yield* completion.isWaiting).toBe(false);
      }),
    ),
  );

  it.effect("interrupts an active timeout action when its scope closes", () =>
    Effect.gen(function* () {
      const started = Latch.makeUnsafe();
      const interrupted = Latch.makeUnsafe();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* makeSynchronizationCompletion({
            onTimeout: started.open.pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => interrupted.open.pipe(Effect.asVoid)),
            ),
          });
          yield* completion.startWaiting;
          yield* completion.arm;
          yield* TestClock.adjust("15 seconds");
          yield* started.await;
        }),
      );

      yield* interrupted.await;
    }),
  );
});
