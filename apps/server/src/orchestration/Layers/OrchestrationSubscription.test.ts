import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { subscribeToDomainEvents } from "./OrchestrationEngine.ts";

describe("orchestration domain event subscriptions", () => {
  it.effect("retains an event emitted after subscription and before the stream is pulled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<number>();
        const subscribedEvents = yield* subscribeToDomainEvents(events);
        yield* PubSub.publish(events, 1);

        const event = yield* subscribedEvents.pipe(Stream.runHead, Effect.timeout("1 second"));
        expect(event).toEqual(Option.some(1));
      }),
    ),
  );
});
