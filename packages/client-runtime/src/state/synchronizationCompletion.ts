import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

const SYNCHRONIZATION_COMPLETION_TIMEOUT = "15 seconds";

export function makeSynchronizationCompletion(options: {
  readonly onTimeout: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make({ awaiting: false, attempt: 0 });
    const deadline = yield* FiberHandle.make<void, never>();
    const transitions = yield* Semaphore.make(1);

    const startWaiting = transitions
      .withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => ({
            awaiting: true,
            attempt: current.attempt + 1,
          }));
          yield* FiberHandle.clear(deadline);
        }),
      )
      .pipe(Effect.uninterruptible);
    const stop = transitions
      .withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.update(state, (current) => ({
            awaiting: false,
            attempt: current.attempt + 1,
          }));
          yield* FiberHandle.clear(deadline);
        }),
      )
      .pipe(Effect.uninterruptible);
    const arm = transitions
      .withPermits(1)(
        Effect.gen(function* () {
          const armedAttempt = yield* Ref.modify(state, (current) => {
            if (!current.awaiting) return [null, current] as const;
            const attempt = current.attempt + 1;
            return [attempt, { awaiting: true, attempt }] as const;
          });
          if (armedAttempt === null) return;

          yield* FiberHandle.run(
            deadline,
            Effect.sleep(SYNCHRONIZATION_COMPLETION_TIMEOUT).pipe(
              Effect.andThen(
                transitions.withPermits(1)(
                  Ref.get(state).pipe(
                    Effect.map((current) => current.awaiting && current.attempt === armedAttempt),
                  ),
                ),
              ),
              Effect.flatMap((shouldTimeout) => (shouldTimeout ? options.onTimeout : Effect.void)),
              Effect.interruptible,
            ),
          );
        }),
      )
      .pipe(Effect.uninterruptible);

    return {
      startWaiting,
      isWaiting: Ref.get(state).pipe(Effect.map((current) => current.awaiting)),
      stop,
      arm,
    } as const;
  });
}
