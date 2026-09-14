import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  GitManagerError,
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
});
