import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { CoderHelperConnection } from "./helperConnection.ts";

const DEFAULT_LATENCY_TIMEOUT_MS = 5_000;
const HELPER_PING_MESSAGE = { _tag: "Ping" } as const;

export class CoderHelperLatencyError extends Error {
  readonly _tag = "CoderHelperLatencyError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderHelperLatencyError";
  }
}

export interface CoderHelperLatencySample {
  readonly latencyMs: number;
  readonly sampledAt: number;
}

export function measureCoderHelperLatency(
  helper: Pick<CoderHelperConnection, "sendRpc" | "onRpcMessage">,
  options?: {
    readonly timeoutMs?: number;
  },
): Effect.Effect<CoderHelperLatencySample, CoderHelperLatencyError> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LATENCY_TIMEOUT_MS;
  return Effect.gen(function* () {
    const pong = yield* Deferred.make<void>();
    let unsubscribe: (() => void) | undefined;
    const onPong = (message: unknown): void => {
      if (!Predicate.isObject(message) || message._tag !== "Pong") return;
      unsubscribe?.();
      unsubscribe = undefined;
      Deferred.doneUnsafe(pong, Effect.void);
    };
    const startedAtMs = performance.now();
    return yield* Effect.gen(function* () {
      unsubscribe = helper.onRpcMessage(onPong);
      yield* helper
        .sendRpc(HELPER_PING_MESSAGE)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CoderHelperLatencyError("Coder workspace helper is disconnected.", { cause }),
          ),
        );
      yield* Deferred.await(pong).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.void
            : Effect.fail(
                new CoderHelperLatencyError(
                  "Timed out measuring Coder workspace helper latency.",
                ),
              ),
        ),
      );
      return {
        latencyMs: Math.max(0, performance.now() - startedAtMs),
        sampledAt: Date.now(),
      } satisfies CoderHelperLatencySample;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          unsubscribe?.();
          unsubscribe = undefined;
        }),
      ),
    );
  });
}
