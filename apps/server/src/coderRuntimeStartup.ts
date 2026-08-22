import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export class CoderRuntimeStartupError extends Schema.TaggedErrorClass<CoderRuntimeStartupError>()(
  "CoderRuntimeStartupError",
  { cause: Schema.Defect() },
) {}

export class CoderRuntimeStartup extends Context.Service<
  CoderRuntimeStartup,
  {
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | CoderRuntimeStartupError>;
  }
>()("t3/coderRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

export const makeCommandGate = Effect.gen(function* () {
  const ready = yield* Deferred.make<void>();
  const queue = yield* Queue.unbounded<QueuedCommand>();
  const isReady = yield* Ref.make(false);
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(queue).pipe(Effect.flatMap((command) => command.run))),
  );

  return {
    signalReady: Ref.set(isReady, true).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        if (yield* Ref.get(isReady)) return yield* effect;
        const result = yield* Deferred.make<A, E | CoderRuntimeStartupError>();
        yield* Queue.offer(queue, {
          run: Deferred.await(ready).pipe(
            Effect.andThen(effect),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit)
                ? Deferred.succeed(result, exit.value)
                : Deferred.failCause(result, exit.cause),
            ),
            Effect.asVoid,
          ),
        });
        return yield* Deferred.await(result);
      }),
  };
});
