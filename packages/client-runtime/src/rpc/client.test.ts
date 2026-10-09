import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
<<<<<<< ours
  GitManagerError,
||||||| base
  PreviewTabId,
  ThreadId,
  type PreviewAutomationStreamEvent,
  type RelayClientInstallProgressEvent,
=======
  type RelayClientInstallProgressEvent,
>>>>>>> theirs
  type ServerConfigStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
<<<<<<< ours
||||||| base
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
=======
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
>>>>>>> theirs

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import { request, runStream, subscribe } from "./client.ts";
import { setErrorDiagnosticReporter, type ErrorDiagnostic } from "../errors/diagnostics.ts";

const TARGET = new ConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return { activeSession, supervisor };
});

describe("environment RPC", () => {
<<<<<<< ours
  it.effect(
    "records unary, streamed, and recovered subscription failures before callers handle them",
    () =>
      Effect.gen(function* () {
        const diagnostics: ErrorDiagnostic[] = [];
        const restore = setErrorDiagnosticReporter((event) => diagnostics.push(event));
        yield* Effect.addFinalizer(() => Effect.sync(restore));
        const checkoutError = new GitManagerError({
          operation: "preparePullRequestThread",
          cwd: "/private-repo",
          detail: "This merge-request branch is already checked out in the main repository.",
        });
        const streamError = new Error("Push failed");
        const subscriptionError = new Error("Subscription failed");
        const client = {
          [WS_METHODS.gitPreparePullRequestThread]: () => Effect.fail(checkoutError),
          [WS_METHODS.gitRunStackedAction]: () => Stream.fail(streamError),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(
          activeSession,
          Option.some({
            client,
            initialConfig: Effect.never,
            subscribeServerConfig: () => Stream.fail(subscriptionError),
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as unknown as RpcSession.RpcSession),
        );
        const checkout = yield* request(WS_METHODS.gitPreparePullRequestThread, {
          cwd: "/private-repo",
          reference: "42",
          mode: "worktree",
        }).pipe(
          Effect.flip,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(checkout).toBe(checkoutError);
        yield* runStream(WS_METHODS.gitRunStackedAction, {
          actionId: "test",
          cwd: "/private-repo",
          action: "push",
        }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        const handled = yield* Deferred.make<void>();
        const subscription = yield* subscribe(
          WS_METHODS.subscribeServerConfig,
          {},
          {
            onExpectedFailure: () => Deferred.succeed(handled, undefined).pipe(Effect.asVoid),
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(handled);
        yield* Fiber.interrupt(subscription);
        expect(diagnostics.map((entry) => entry.source)).toEqual([
          WS_METHODS.gitPreparePullRequestThread,
          WS_METHODS.gitRunStackedAction,
          WS_METHODS.subscribeServerConfig,
        ]);
        expect(diagnostics[0]?.message).toContain("already checked out in the main repository");
        expect(JSON.stringify(diagnostics)).not.toContain("/private-repo");
      }),
  );

||||||| base
  it.effect("registers a fresh preview host after completion without replaying requests", () =>
    Effect.gen(function* () {
      const firstCompleted = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const requests: string[] = [];
      const connections: string[] = [];
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            const connected: PreviewAutomationStreamEvent = {
              type: "connected",
              connectionId: `connection-${attempts}`,
            };
            return attempts === 1
              ? Stream.make(connected, {
                  type: "request",
                  connectionId: connected.connectionId,
                  request: {
                    requestId: "timed-out-action",
                    operation: "click",
                    threadId: ThreadId.make("thread-1"),
                    tabId: PreviewTabId.make("tab-1"),
                    input: {},
                    timeoutMs: 1_000,
                  },
                } satisfies PreviewAutomationStreamEvent).pipe(
                  Stream.ensuring(Deferred.succeed(firstCompleted, undefined)),
                )
              : Stream.succeed(connected).pipe(Stream.concat(Stream.never));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runForEach((event) => {
          if (event.type === "request") {
            requests.push(event.request.requestId);
            return Effect.void;
          }
          connections.push(event.connectionId);
          return connections.length === 2 ? Deferred.succeed(reconnected, undefined) : Effect.void;
        }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstCompleted);
      yield* TestClock.adjust(999);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      expect(attempts).toBe(2);
      yield* Deferred.await(reconnected);
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(requests).toEqual(["timed-out-action"]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("does not re-register an unmounted preview host during the recovery delay", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            return Stream.empty.pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(consumer);
      yield* TestClock.adjust(10_000);
      expect(attempts).toBe(1);
    }),
  );

  it.effect.each(["completion", "transport failure"] as const)(
    "keeps preview recovery tied to the active session after %s",
    (reason) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const nextConnected = yield* Deferred.make<void>();
        let oldAttempts = 0;
        let nextAttempts = 0;
        const firstClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              oldAttempts += 1;
              return (
                reason === "completion"
                  ? Stream.empty
                  : Stream.fail(
                      new RpcClientError.RpcClientError({
                        reason: new RpcClientError.RpcClientDefect({
                          message: "socket closed",
                          cause: new Error("socket closed"),
                        }),
                      }),
                    )
              ).pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
            }),
        } as unknown as WsRpcProtocolClient;
        const nextClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              nextAttempts += 1;
              return Stream.fromEffect(Deferred.succeed(nextConnected, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              );
            }),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
          clientId: "preview-host",
          environmentId: TARGET.environmentId,
        }).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(completed);
        if (reason === "transport failure") {
          yield* TestClock.adjust(10_000);
          expect(oldAttempts).toBe(1);
        }
        yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
        yield* Deferred.await(nextConnected);
        yield* TestClock.adjust(10_000);
        expect(oldAttempts).toBe(1);
        expect(nextAttempts).toBe(1);
        yield* Fiber.interrupt(consumer);
      }),
  );

=======
>>>>>>> theirs
  it.effect("reuses the session config stream instead of opening a duplicate subscription", () =>
    Effect.gen(function* () {
      const event: ServerConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      };
      let duplicateSubscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => {
          duplicateSubscriptions += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.succeed(event),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        }),
      );

      const received = yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(received).toEqual(Option.some(event));
      expect(duplicateSubscriptions).toBe(0);
    }),
  );
<<<<<<< ours
||||||| base

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );

  it.effect("reports an initializer defect once after an expected failure retries", () =>
    Effect.gen(function* () {
      const defect = new Error("Synthetic retry initializer defect");
      const expectedFailure = yield* Deferred.make<void>();
      const observations: string[] = [];
      const observedDefects: unknown[] = [];
      let inputs = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          observations.push("stream");
          return Stream.fail(new Error("subscription not ready"));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeTerminalEvents,
        () =>
          Effect.sync(() => {
            inputs += 1;
            observations.push(`input ${inputs}`);
            return inputs;
          }).pipe(
            Effect.flatMap((attempt) => (attempt === 1 ? Effect.succeed({}) : Effect.die(defect))),
          ),
        {
          onDefect: (cause) =>
            Effect.sync(() => {
              observations.push("defect");
              observedDefects.push(Cause.squash(cause));
            }),
          onExpectedFailure: () =>
            Effect.sync(() => {
              observations.push("expected failure");
            }).pipe(Effect.andThen(Deferred.succeed(expectedFailure, undefined)), Effect.asVoid),
          retryExpectedFailureAfter: "250 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(expectedFailure);
      yield* TestClock.adjust("250 millis");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(observations).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
      expect(observedDefects).toEqual([defect]);
    }),
  );
=======

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect("doubles the retry delay for repeated failures and resets it after a value", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not hydrated yet");
      const subscriptions = yield* Queue.unbounded<number>();
      const failures = yield* Queue.unbounded<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Effect.sync(() => {
              attempts += 1;
              return attempts;
            }).pipe(
              Effect.tap((attempt) => Queue.offer(subscriptions, attempt)),
              Effect.map((attempt) => {
                if (attempt <= 2) return Stream.fail(domainError);
                if (attempt === 3)
                  return Stream.concat(Stream.make("event"), Stream.fail(domainError));
                return Stream.never;
              }),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Queue.offer(failures, undefined),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      expect(yield* Queue.take(subscriptions)).toBe(1);
      yield* Queue.take(failures);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(2);
      yield* Queue.take(failures);
      // The second retry waits 200ms, so 100ms is not enough.
      yield* TestClock.adjust("100 millis");
      expect(Option.isNone(yield* Queue.poll(subscriptions))).toBe(true);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(3);
      // Attempt 3 delivered a value before failing, so the delay is back to 100ms.
      yield* Queue.take(failures);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(4);
      yield* Fiber.interrupt(subscriptionFiber);
    }),
  );

  it.effect("waits for the next session after an authorization failure", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Queue.unbounded<void>();
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Queue.offer(subscriptions, undefined).pipe(
              Effect.map(() => {
                attempts += 1;
                return attempts === 1
                  ? Stream.fail(
                      new EnvironmentAuthorizationError({
                        message: "Missing scope",
                        requiredScope: "orchestration:read",
                      }),
                    )
                  : Stream.never;
              }),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* Queue.take(subscriptions);
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 minute");
      expect(Option.isNone(yield* Queue.poll(subscriptions))).toBe(true);

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      yield* Queue.take(subscriptions);
      yield* Fiber.interrupt(subscriptionFiber);
      expect(attempts).toBe(2);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );

  it.effect("reports an initializer defect once after an expected failure retries", () =>
    Effect.gen(function* () {
      const defect = new Error("Synthetic retry initializer defect");
      const expectedFailure = yield* Deferred.make<void>();
      const observations: string[] = [];
      const observedDefects: unknown[] = [];
      let inputs = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          observations.push("stream");
          return Stream.fail(new Error("subscription not ready"));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeTerminalEvents,
        () =>
          Effect.sync(() => {
            inputs += 1;
            observations.push(`input ${inputs}`);
            return inputs;
          }).pipe(
            Effect.flatMap((attempt) => (attempt === 1 ? Effect.succeed({}) : Effect.die(defect))),
          ),
        {
          onDefect: (cause) =>
            Effect.sync(() => {
              observations.push("defect");
              observedDefects.push(Cause.squash(cause));
            }),
          onExpectedFailure: () =>
            Effect.sync(() => {
              observations.push("expected failure");
            }).pipe(Effect.andThen(Deferred.succeed(expectedFailure, undefined)), Effect.asVoid),
          retryExpectedFailureAfter: "250 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(expectedFailure);
      yield* TestClock.adjust("250 millis");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(observations).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
      expect(observedDefects).toEqual([defect]);
    }),
  );
>>>>>>> theirs
});
