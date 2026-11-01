import type { DiscoveredCoderWorkspace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { CoderProfileConfig } from "@t3tools/coder-cli/configStore";
import {
  buildCoderListWorkspacesInvocation,
  buildCoderPortForwardInvocation,
  type CoderInvocation,
  type CoderInvocationOptions,
} from "@t3tools/coder-cli/command";
import type { CoderPortForwardConnection } from "@t3tools/coder-cli/portForward";
import { discoveredWorkspaceMatches } from "./coderCommands.ts";
import { portForwardIsCurrent } from "./configChanges.ts";
import {
  makeDeferredPromise,
  type PortForwardLifecycleState,
  type PortForwardStartClaim,
  type PortForwardStopClaim,
  type RunFork,
  type RunPromise,
} from "./lifecycleState.ts";

export interface PortForwardManagerOptions {
  readonly runPromise: RunPromise;
  readonly runFork: RunFork;
  /** Each forward's child runs in a scope forked from the gateway's. */
  readonly gatewayScope: Scope.Scope;
  /** The gateway's current configuration. */
  readonly config: () => CoderProfileConfig;
  readonly isClosed: () => boolean;
  readonly coderInvocationOptions: (deploymentId: string) => CoderInvocationOptions;
  readonly openPortForward: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderPortForwardConnection, unknown, Scope.Scope>;
  readonly listWorkspaces: (
    invocation: CoderInvocation,
  ) => Effect.Effect<readonly DiscoveredCoderWorkspace[], unknown>;
}

export type PortForwardManager = ReturnType<typeof makePortForwardManager>;

/** The saved port-forward rules' lifecycles: one foreground `coder port-forward` child each. */
/** A rule held back only because its workspace was starting; any later start retries it. */
const WORKSPACE_STARTING_ERROR = "Coder workspace is starting.";

/** A rule whose own forward failed stays stopped until it is restarted or changed. */
const isFailedRule = (state: PortForwardLifecycleState) =>
  state._tag === "Failed" && state.error !== WORKSPACE_STARTING_ERROR;

export function makePortForwardManager(deps: PortForwardManagerOptions) {
  const {
    runPromise,
    runFork,
    gatewayScope,
    config,
    isClosed,
    coderInvocationOptions,
    openPortForward,
    listWorkspaces,
  } = deps;
  const portForwardLifecycles = new Map<
    string,
    SynchronizedRef.SynchronizedRef<PortForwardLifecycleState>
  >();
  const portForwardLifecycle = (portForwardId: string) => {
    const existing = portForwardLifecycles.get(portForwardId);
    if (existing !== undefined) return existing;
    const created = SynchronizedRef.makeUnsafe<PortForwardLifecycleState>({
      _tag: "Idle",
      generation: 0,
    });
    portForwardLifecycles.set(portForwardId, created);
    return created;
  };

  const ensurePortForward = async (portForwardId: string): Promise<CoderPortForwardConnection> => {
    if (isClosed()) throw new Error("Coder gateway is closed.");
    const lifecycle = portForwardLifecycle(portForwardId);
    const deferred = makeDeferredPromise<CoderPortForwardConnection>();
    const claim = await runPromise(
      SynchronizedRef.modify<PortForwardLifecycleState, PortForwardStartClaim>(
        lifecycle,
        (state) => {
          switch (state._tag) {
            case "ShutdownFailed":
              return [{ _tag: "ShutdownFailed" as const, error: state.error }, state];
            case "Running":
              return [{ _tag: "Existing" as const, connection: state.connection }, state];
            case "Starting":
              return [{ _tag: "Pending" as const, operation: state.operation }, state];
            case "Stopping":
              return [{ _tag: "Stopping" as const, operation: state.operation }, state];
            case "Idle":
            case "WorkspaceStopped":
            case "Failed":
              return [
                { _tag: "Start" as const, generation: state.generation },
                {
                  _tag: "Starting" as const,
                  generation: state.generation,
                  operation: deferred.promise,
                },
              ];
          }
        },
      ),
    );
    if (claim._tag === "ShutdownFailed") throw new Error(claim.error);
    if (claim._tag === "Existing") return claim.connection;
    if (claim._tag === "Pending") return claim.operation;
    if (claim._tag === "Stopping") {
      await claim.operation;
      return ensurePortForward(portForwardId);
    }

    const generation = claim.generation;
    const startIsCurrent = () => {
      const state = SynchronizedRef.getUnsafe(lifecycle);
      return (
        !isClosed() &&
        state._tag === "Starting" &&
        state.generation === generation &&
        state.operation === deferred.promise
      );
    };
    void runPromise(
      Effect.gen(function* () {
        const connectionConfig = config();
        const portForward = connectionConfig.portForwards?.find(
          (entry) => entry.id === portForwardId,
        );
        const workspace = connectionConfig.workspaces.find(
          (entry) => entry.id === portForward?.workspaceId,
        );
        const deployment = connectionConfig.deployments.find(
          (entry) => entry.id === workspace?.deploymentId,
        );
        if (portForward === undefined || workspace === undefined || deployment === undefined) {
          return yield* Effect.fail(new Error("Unknown Coder port forward."));
        }

        const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
        let acquired: CoderPortForwardConnection | undefined;
        return yield* Effect.gen(function* () {
          const connection = yield* openPortForward(
            buildCoderPortForwardInvocation(
              deployment,
              workspace,
              portForward,
              coderInvocationOptions(deployment.id),
            ),
          ).pipe(Scope.provide(connectionScope));
          acquired = connection;
          runFork(
            connection.closed.pipe(
              Effect.tap((exit) =>
                SynchronizedRef.update(lifecycle, (state) => {
                  if (state._tag === "Stopping" && state.shutdownFailure?.connection === connection)
                    return { ...state, shutdownFailure: undefined };
                  if (
                    !(
                      (state._tag === "Running" || state._tag === "ShutdownFailed") &&
                      state.connection === connection
                    ) &&
                    !(state._tag === "Starting" && state.operation === deferred.promise)
                  )
                    return state;
                  if (
                    !exit.expected &&
                    !isClosed() &&
                    portForwardIsCurrent(connectionConfig, config(), portForwardId)
                  ) {
                    return {
                      _tag: "Failed",
                      generation: state.generation,
                      error: exit.reason ?? "Coder port forward stopped unexpectedly.",
                    } as const;
                  }
                  return { _tag: "Idle", generation: state.generation } as const;
                }),
              ),
              Effect.ensuring(Scope.close(connectionScope, Exit.void)),
            ),
          );
          if (
            !startIsCurrent() ||
            !portForwardIsCurrent(connectionConfig, config(), portForwardId)
          ) {
            return yield* Effect.fail(new Error("Coder port forward was cancelled."));
          }

          const running = yield* SynchronizedRef.modify(lifecycle, (state) => {
            if (
              state._tag !== "Starting" ||
              state.generation !== generation ||
              state.operation !== deferred.promise
            ) {
              return [false, state];
            }
            return [
              true,
              {
                _tag: "Running" as const,
                generation,
                connection,
                scope: connectionScope,
              },
            ];
          });
          if (!running) {
            return yield* Effect.fail(new Error("Coder port forward was cancelled."));
          }
          return connection;
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              if (acquired) {
                // Keep the scope retriable until the child confirms shutdown.
                const connection = acquired;
                yield* connection.close.pipe(
                  Effect.onError(() =>
                    SynchronizedRef.update(lifecycle, (state) => {
                      const failure = {
                        _tag: "ShutdownFailed" as const,
                        generation: state.generation,
                        connection,
                        scope: connectionScope,
                        error:
                          "Coder child shutdown failed. Retry stopping it before reconnecting.",
                      };
                      return state._tag === "Stopping"
                        ? { ...state, shutdownFailure: failure }
                        : failure;
                    }),
                  ),
                );
              }
              yield* Scope.close(connectionScope, Exit.void);
            }),
          ),
        );
      }),
    ).then(deferred.resolve, (cause) => {
      void runPromise(
        SynchronizedRef.update(lifecycle, (state) =>
          state._tag === "Starting" && state.operation === deferred.promise
            ? ({
                _tag: "Failed",
                generation: state.generation,
                error:
                  cause instanceof Error ? cause.message : "Coder port forward failed to start.",
              } as const)
            : state,
        ),
      ).then(
        () => deferred.reject(cause),
        () => deferred.reject(cause),
      );
    });
    return deferred.promise;
  };

  const stopPortForward = async (portForwardId: string): Promise<void> => {
    const lifecycle = portForwardLifecycle(portForwardId);
    const deferred = makeDeferredPromise<void>();
    const claim = await runPromise(
      SynchronizedRef.modify<PortForwardLifecycleState, PortForwardStopClaim>(
        lifecycle,
        (state) => {
          if (state._tag === "Stopping") {
            return [{ _tag: "Pending" as const, operation: state.operation }, state];
          }
          const generation = state.generation + 1;
          if (
            state._tag === "Idle" ||
            state._tag === "WorkspaceStopped" ||
            state._tag === "Failed"
          ) {
            return [{ _tag: "Stopped" as const }, { _tag: "Idle", generation }];
          }
          return [
            {
              _tag: "Stop" as const,
              pending: state._tag === "Starting" ? state.operation : undefined,
              scope:
                state._tag === "Running" || state._tag === "ShutdownFailed"
                  ? state.scope
                  : undefined,
              previous:
                state._tag === "Running" || state._tag === "ShutdownFailed" ? state : undefined,
            },
            { _tag: "Stopping", generation, operation: deferred.promise },
          ];
        },
      ),
    );
    if (claim._tag === "Stopped") return;
    if (claim._tag === "Pending") return claim.operation;
    void (async () => {
      try {
        if (claim.previous) await runPromise(claim.previous.connection.close);
        if (claim.scope !== undefined) {
          await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
        }
        if (claim.pending !== undefined)
          await claim.pending.catch((cause) => {
            const state = SynchronizedRef.getUnsafe(lifecycle);
            if (
              state._tag === "ShutdownFailed" ||
              ("shutdownFailure" in state && state.shutdownFailure)
            )
              throw cause;
          });
        await runPromise(
          SynchronizedRef.update(lifecycle, (state) =>
            state._tag === "Stopping" && state.operation === deferred.promise
              ? ({ _tag: "Idle", generation: state.generation } as const)
              : state,
          ),
        );
        deferred.resolve(undefined);
      } catch (cause) {
        await runPromise(
          SynchronizedRef.update(lifecycle, (state) =>
            state._tag === "Stopping" && state.operation === deferred.promise
              ? (state.shutdownFailure ??
                (claim.previous
                  ? {
                      ...claim.previous,
                      _tag: "ShutdownFailed" as const,
                      generation: state.generation,
                      error: "Coder child shutdown failed. Retry stopping it before reconnecting.",
                    }
                  : {
                      _tag: "Failed" as const,
                      generation: state.generation,
                      error: "Coder port forward shutdown failed.",
                    }))
              : state,
          ),
        );
        deferred.reject(cause);
      }
    })();
    return deferred.promise;
  };

  /**
   * Starts the saved rules. A config save passes `retryFailed: false`: a rule that failed stays
   * stopped until it is restarted or changed (a changed rule's lifecycle is recreated as idle).
   */
  const startConfiguredPortForwards = async (options?: {
    readonly retryFailed?: boolean;
  }): Promise<void> => {
    if ((config().portForwards?.length ?? 0) === 0) return;
    const workspacesByDeployment = new Map<
      string,
      readonly DiscoveredCoderWorkspace[] | undefined
    >();
    await Promise.all(
      config().deployments.map(async (deployment) => {
        try {
          workspacesByDeployment.set(
            deployment.id,
            await runPromise(
              listWorkspaces(
                buildCoderListWorkspacesInvocation(
                  deployment,
                  coderInvocationOptions(deployment.id),
                ),
              ),
            ),
          );
        } catch {
          workspacesByDeployment.set(deployment.id, undefined);
        }
      }),
    );
    await Promise.allSettled(
      (config().portForwards ?? []).map(async (portForward) => {
        if (
          options?.retryFailed === false &&
          isFailedRule(SynchronizedRef.getUnsafe(portForwardLifecycle(portForward.id)))
        ) {
          return;
        }
        const workspace = config().workspaces.find((entry) => entry.id === portForward.workspaceId);
        const runtime =
          workspace === undefined
            ? undefined
            : workspacesByDeployment
                .get(workspace.deploymentId)
                ?.find((entry) => discoveredWorkspaceMatches(entry, workspace));
        if (runtime?.status === "stopped") {
          await runPromise(
            SynchronizedRef.update(
              portForwardLifecycle(portForward.id),
              (state) =>
                ({
                  _tag: "WorkspaceStopped",
                  generation: state.generation,
                }) as const,
            ),
          );
          return;
        }
        if (runtime?.status === "starting") {
          await runPromise(
            SynchronizedRef.update(
              portForwardLifecycle(portForward.id),
              (state) =>
                ({
                  _tag: "Failed",
                  generation: state.generation,
                  error: WORKSPACE_STARTING_ERROR,
                }) as const,
            ),
          );
          return;
        }
        await ensurePortForward(portForward.id);
      }),
    );
  };

  return {
    portForwardLifecycles,
    portForwardLifecycle,
    ensurePortForward,
    stopPortForward,
    startConfiguredPortForwards,
  };
}
