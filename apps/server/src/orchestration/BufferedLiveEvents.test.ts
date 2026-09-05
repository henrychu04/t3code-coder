import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { bufferLiveEvents } from "./BufferedLiveEvents.ts";

it.effect("unsubscribes when the client stops acknowledging an already delivered batch", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<{ text: string }>();
    const closed = yield* Deferred.make<void>();
    const live = yield* bufferLiveEvents(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
        return Stream.fromSubscription(yield* PubSub.subscribe(events));
      }),
      { maxItems: 2 },
    );
    const pull = yield* Stream.toPull(live);
    yield* PubSub.publish(events, { text: "first" });
    expect(yield* pull).toEqual([{ text: "first" }]);
    yield* PubSub.publishAll(events, [{ text: "second" }, { text: "overflow" }]);
    // No second pull: the publisher subscription must still be released now.
    yield* Deferred.await(closed);
    expect((yield* pull.pipe(Effect.result))._tag).toBe("Failure");
  }),
);

it.effect("delivers and completes a finite source", () =>
  Effect.gen(function* () {
    const live = yield* bufferLiveEvents(Effect.succeed(Stream.make({ text: "one" })));
    expect(yield* Stream.runCollect(live)).toEqual([{ text: "one" }]);
  }),
);

for (const limits of [{ maxItems: 2 }, { maxSerializedBytes: 24 }]) {
  it.effect(`releases a stalled subscription before its next pull: ${JSON.stringify(limits)}`, () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<{ text: string }>();
      const closed = yield* Deferred.make<void>();
      const subscribe = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
        return Stream.fromSubscription(yield* PubSub.subscribe(events));
      });
      const live = yield* bufferLiveEvents(subscribe, limits);
      // Simulate snapshot loading: downstream has not even asked for its first batch.
      yield* PubSub.publishAll(events, [{ text: "one" }, { text: "two" }, { text: "three" }]);
      yield* Deferred.await(closed);
      const result = yield* Stream.runCollect(live).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      // Overflow must not stall the shared publisher or poison another subscription.
      const healthy = yield* PubSub.subscribe(events);
      yield* PubSub.publish(events, { text: "healthy" });
      expect(yield* Stream.runHead(Stream.fromSubscription(healthy))).toMatchObject({
        value: { text: "healthy" },
      });
    }),
  );
}
