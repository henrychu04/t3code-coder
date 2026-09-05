import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderServiceLive } from "./ProviderService.ts";

const threadId = ThreadId.make("compaction-thread");
const instanceId = ProviderInstanceId.make("codex");
const provider = ProviderDriverKind.make("codex");
const turnId = TurnId.make("compact-turn");
const requestId = MessageId.make("compact-request");
const baseEvent = {
  eventId: EventId.make("event"),
  threadId,
  provider,
  createdAt: "2026-09-04T10:00:00.000Z",
};
const compacted = {
  ...baseEvent,
  type: "thread.state.changed",
  payload: { state: "compacted" },
} satisfies ProviderRuntimeEvent;
const completed = {
  ...baseEvent,
  turnId,
  type: "turn.completed",
  payload: { state: "completed" },
} satisfies ProviderRuntimeEvent;

const harness = (
  options: { native?: boolean; startFailure?: boolean; earlyCompletion?: boolean } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const changes = yield* PubSub.unbounded<void>();
    const started = yield* Deferred.make<void>();
    let starts = 0;
    const adapter: ProviderAdapterShape<ProviderAdapterRequestError> = {
      provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: () => Effect.die("unused"),
      sendTurn: () =>
        Effect.gen(function* () {
          starts++;
          yield* Deferred.succeed(started, undefined);
          if (options.earlyCompletion) {
            yield* Queue.offer(events, completed);
            yield* Effect.yieldNow;
          }
          return { threadId, turnId };
        }),
      ...(options.native === false
        ? {}
        : {
            compactThread: () =>
              Effect.gen(function* () {
                starts++;
                yield* Deferred.succeed(started, undefined);
                if (options.startFailure)
                  return yield* new ProviderAdapterRequestError({
                    provider,
                    method: "thread/compact",
                    detail: "start failed",
                  });
              }),
          }),
      interruptTurn: () => Effect.void,
      stopSession: () => Effect.void,
      stopAll: () => Effect.void,
      hasSession: () => Effect.succeed(true),
      listSessions: () => Effect.succeed([] as ProviderSession[]),
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      readThread: () => Effect.die("unused"),
      rollbackThread: () => Effect.die("unused"),
      streamEvents: Stream.fromQueue(events),
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderAdapterRegistry, {
        getByInstance: () => Effect.succeed(adapter),
        getInstanceInfo: () => Effect.die("unused"),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([provider]),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
      }),
      Layer.succeed(ProviderSessionDirectory, {
        getBinding: () =>
          Effect.succeed(Option.some({ threadId, provider, providerInstanceId: instanceId })),
        upsert: () => Effect.void,
        getProvider: () => Effect.succeed(provider),
        listThreadIds: () => Effect.succeed([threadId]),
        listBindings: () => Effect.succeed([]),
      }),
      Layer.succeed(ServerConfig, {
        cwd: "/unused",
        baseDir: "/unused",
        stateDir: "/unused",
        dbPath: "/unused",
        keybindingsConfigPath: "/unused",
        settingsPath: "/unused",
        providerStatusCacheDir: "/unused",
        worktreesDir: "/unused",
        logsDir: "/unused",
        terminalLogsDir: "/unused",
        environmentIdPath: "/unused",
        attachmentsDir: "/unused",
        screenshotArtifactsDir: "/unused",
      }),
    );
    const context = yield* Layer.build(ProviderServiceLive.pipe(Layer.provide(dependencies)));
    const service = Context.get(context, ProviderService);
    const published = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* service.streamEvents.pipe(
      Stream.runForEach((event) => Queue.offer(published, event)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return { service, events, published, started, starts: () => starts };
  });

describe("ProviderService compaction lifecycle", () => {
  for (const event of [
    completed,
    { ...baseEvent, type: "runtime.error", payload: { message: "Transient error" } },
    { ...baseEvent, turnId, type: "turn.aborted", payload: { reason: "Other turn interrupted" } },
  ] satisfies ProviderRuntimeEvent[]) {
    it.effect(
      `native compaction ignores unrelated ${event.type} and preserves request correlation`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness();
          const fiber = yield* h.service
            .compactThread(threadId, undefined, requestId)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(h.started);
          yield* Queue.offer(h.events, event);
          assert.equal((yield* Queue.take(h.published)).type, event.type);
          yield* Effect.yieldNow;
          assert.match(
            (yield* h.service.sendTurn({ threadId, input: "next" }).pipe(Effect.flip)).message,
            /compaction may still be running/,
          );
          yield* Queue.offer(h.events, compacted);
          yield* Fiber.join(fiber);
          assert.equal(
            (yield* Queue.take(h.published)).requestId,
            RuntimeRequestId.make(requestId),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const providerEmitsCompacted of [false, true]) {
    it.effect(
      `fallback publishes one correlated completion (native signal: ${providerEmitsCompacted})`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness({ native: false });
          const fiber = yield* h.service
            .compactThread(threadId, undefined, requestId)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(h.started);
          if (providerEmitsCompacted) yield* Queue.offer(h.events, { ...compacted, turnId });
          yield* Queue.offer(h.events, completed);
          yield* Fiber.join(fiber);
          // A subsequent event is a barrier proving all compaction events were published.
          const barrier = {
            ...baseEvent,
            eventId: EventId.make("barrier"),
            type: "runtime.error",
            payload: { message: "barrier" },
          } satisfies ProviderRuntimeEvent;
          yield* Queue.offer(h.events, barrier);
          const seen: ProviderRuntimeEvent[] = [];
          while (true) {
            const event = yield* Queue.take(h.published);
            if (event.eventId === barrier.eventId) break;
            seen.push(event);
          }
          const completions = seen.filter(
            (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
          );
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.requestId, RuntimeRequestId.make(requestId));
        }).pipe(Effect.scoped),
    );
  }

  it.effect("waits for native completion and rejects overlapping requests", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const fiber = yield* h.service
        .compactThread(threadId, undefined, requestId)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      const overlap = yield* h.service.compactThread(threadId).pipe(Effect.flip);
      assert.match(overlap.message, /already in progress/);
      assert.equal(h.starts(), 1);
      yield* Queue.offer(h.events, compacted);
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("releases its claim after a failed start", () =>
    Effect.gen(function* () {
      const h = yield* harness({ startFailure: true });
      yield* h.service.compactThread(threadId).pipe(Effect.flip);
      yield* h.service.compactThread(threadId).pipe(Effect.flip);
      assert.equal(h.starts(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks retry after timeout until late completion arrives", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.service.compactThread(threadId).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* TestClock.adjust("10 minutes");
      assert.match((yield* Fiber.join(first)).message, /10 minutes/);
      assert.match((yield* h.service.compactThread(threadId).pipe(Effect.flip)).message, /Restart/);
      assert.match(
        (yield* h.service.sendTurn({ threadId, input: "next turn" }).pipe(Effect.flip)).message,
        /compaction may still be running/,
      );
      yield* Queue.offer(h.events, compacted);
      yield* Effect.yieldNow;
      const retry = yield* h.service.compactThread(threadId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Queue.offer(h.events, compacted);
      yield* Fiber.join(retry);
      assert.equal(h.starts(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("stopping the session settles pending compaction and permits retry", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.service.compactThread(threadId).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* h.service.stopSession({ threadId });
      assert.match((yield* Fiber.join(first)).message, /aborted/);
      const retry = yield* h.service.compactThread(threadId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Queue.offer(h.events, compacted);
      yield* Fiber.join(retry);
      assert.equal(h.starts(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupting the native waiter does not permit an overlapping retry", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const fiber = yield* h.service.compactThread(threadId).pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* Fiber.interrupt(fiber);
      assert.match((yield* h.service.compactThread(threadId).pipe(Effect.flip)).message, /Restart/);
      assert.equal(h.starts(), 1);
      yield* h.service.stopSession({ threadId });
    }).pipe(Effect.scoped),
  );

  it.effect("fallback accepts a completion that arrives before sendTurn returns", () =>
    Effect.gen(function* () {
      const h = yield* harness({ native: false, earlyCompletion: true });
      yield* h.service.compactThread(threadId, undefined, requestId);
      assert.equal(h.starts(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("fallback ignores completion from an unrelated turn", () =>
    Effect.gen(function* () {
      const h = yield* harness({ native: false });
      const fiber = yield* h.service.compactThread(threadId).pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* Queue.offer(h.events, { ...completed, turnId: TurnId.make("other-turn") });
      yield* Effect.yieldNow;
      assert.match(
        (yield* h.service.compactThread(threadId).pipe(Effect.flip)).message,
        /already in progress/,
      );
      yield* Queue.offer(h.events, completed);
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped),
  );
});
