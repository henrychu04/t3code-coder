import { OrchestrationGetSnapshotError } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./LiveStreamBudget.ts";

/** Drain the hot source while a snapshot or RPC ACK is pending, within one bounded budget. */
export const bufferLiveEvents = <A extends object>(
  subscribe: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>,
  limits?: { readonly maxItems?: number; readonly maxSerializedBytes?: number },
) =>
  Effect.gen(function* () {
    const budget = yield* makeLiveStreamBudget(limits);
    const sourceScope = yield* Scope.fork(yield* Effect.scope);
    const source = yield* subscribe.pipe(Scope.provide(sourceScope));
    const queue = yield* Queue.unbounded<
      RetainedLiveItem<A>,
      OrchestrationGetSnapshotError | Cause.Done
    >();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    yield* source.pipe(
      Stream.runForEach((event) =>
        budget.retain(event).pipe(
          Effect.flatMap((item) => Queue.offer(queue, item)),
          Effect.uninterruptible,
        ),
      ),
      Effect.flatMap(() => Queue.end(queue)),
      Effect.raceFirst(budget.failed),
      Effect.catchTags({
        OrchestrationGetSnapshotError: (error) =>
          Effect.gen(function* () {
            // Release the PubSub subscription even if downstream never acknowledges its last batch.
            yield* Scope.close(sourceScope, Exit.fail(error));
            budget.release(yield* Queue.clear(queue).pipe(Effect.orDie));
            yield* Queue.fail(queue, error);
          }),
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    return budget.deliver(Stream.fromQueue(queue));
  });
