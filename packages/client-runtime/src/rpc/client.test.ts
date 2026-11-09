import { EnvironmentId, GitManagerError, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import {
  requestGuarded,
  refreshVcsBranch,
  RpcPermissionGuard,
  runStreamGuarded,
  subscribe,
  subscribeDynamicWithSession,
} from "./client.ts";
import { setErrorDiagnosticReporter, type ErrorDiagnostic } from "../errors/diagnostics.ts";

const TARGET = new ConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

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
        const grantAll = { authorize: () => Effect.void };
        const checkout = yield* requestGuarded(WS_METHODS.gitPreparePullRequestThread, {
          cwd: "/private-repo",
          reference: "42",
          mode: "worktree",
        }).pipe(
          Effect.flip,
          Effect.provideService(RpcPermissionGuard, grantAll),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(checkout).toBe(checkoutError);
        yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
          actionId: "test",
          cwd: "/private-repo",
          action: "push",
        }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.provideService(RpcPermissionGuard, grantAll),
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

  it.effect.each(["input", "stream"] as const)(
    "reports %s subscription defects and resubscribes on the next session",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const defectObserved = yield* Deferred.make<void>();
        const resubscribed = yield* Deferred.make<void>();
        const firstClient = {
          [WS_METHODS.subscribeTerminalMetadata]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const secondClient = {
          [WS_METHODS.subscribeTerminalMetadata]: () => {
            Deferred.doneUnsafe(resubscribed, Effect.void);
            return Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const subscriptionFiber = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalMetadata,
          () =>
            Effect.suspend(() => {
              inputs += 1;
              return where === "input" && inputs === 1 ? Effect.die(defect) : Effect.succeed({});
            }),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
                Deferred.doneUnsafe(defectObserved, Effect.void);
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
          Effect.forkChild,
        );
        yield* Deferred.await(defectObserved);

        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);

        // Let the defect settle before the next session arrives, as it does on a real device.
        yield* TestClock.adjust("1 second");
        expect(subscriptionFiber.pollUnsafe()).toBeUndefined();
        yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
        yield* Deferred.await(resubscribed);
        yield* Fiber.interrupt(subscriptionFiber);

        expect(inputs).toBe(2);
      }),
  );
});

it.effect.each([true, false])(
  "refreshes branches using the connected server capability (%s)",
  (supported) =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness();
      const inputs: unknown[] = [];
      const client = {
        [supported ? WS_METHODS.vcsRefreshBranch : WS_METHODS.vcsRefreshStatus]: (
          input: unknown,
        ) => {
          inputs.push(input);
          return Effect.void;
        },
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          initialConfig: Effect.succeed({
            environment: { capabilities: supported ? { vcsBranchStatus: true } : {} },
          } as ServerConfig),
        }),
      );
      expect(
        yield* refreshVcsBranch({ cwd: "/repo" }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ).toBeUndefined();
      expect(inputs).toEqual(supported ? [{ cwd: "/repo" }] : []);
    }).pipe(Effect.scoped),
);

it.effect("binds branch capability selection and execution to one session", () =>
  Effect.gen(function* () {
    const { activeSession, supervisor } = yield* makeHarness();
    const configRequested = yield* Deferred.make<void>();
    const config = yield* Deferred.make<ServerConfig>();
    const executed = yield* Deferred.make<void>();
    const original = {
      [WS_METHODS.vcsRefreshBranch]: () =>
        Deferred.succeed(executed, undefined).pipe(Effect.asVoid),
    } as unknown as WsRpcProtocolClient;
    const replacement = {
      [WS_METHODS.vcsRefreshStatus]: () => Effect.succeed({ refName: "replacement" }),
    } as unknown as WsRpcProtocolClient;
    yield* SubscriptionRef.set(
      activeSession,
      Option.some({
        ...session(original),
        initialConfig: Deferred.succeed(configRequested, undefined).pipe(
          Effect.andThen(Deferred.await(config)),
        ),
      }),
    );
    const refresh = yield* refreshVcsBranch({ cwd: "/repo" }).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.forkChild,
    );
    yield* Deferred.await(configRequested);
    yield* SubscriptionRef.set(activeSession, Option.some(session(replacement)));
    yield* Deferred.succeed(config, {
      environment: { capabilities: { vcsBranchStatus: true } },
    } as ServerConfig);
    expect(yield* Fiber.join(refresh)).toBeUndefined();
    yield* Deferred.await(executed);
  }).pipe(Effect.scoped),
);
