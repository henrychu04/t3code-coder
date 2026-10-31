import type { WorkspaceDiagnosticEvent, WorkspaceDiagnosticPhase } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { WebSocket } from "ws";

import type { CoderProfileConfig } from "@t3tools/coder-cli/configStore";
import {
  buildCoderHelperInvocation,
  buildCoderRestartWorkspaceInvocation,
  buildCoderStartWorkspaceInvocation,
  buildCoderStopWorkspaceInvocation,
  buildCoderUpdateWorkspaceInvocation,
  type CoderInvocation,
  type CoderInvocationOptions,
} from "@t3tools/coder-cli/command";
import {
  CoderHelperInstallRequiredError,
  type CoderHelperConnection,
} from "@t3tools/coder-cli/helperConnection";
import type { installCoderHelper } from "@t3tools/coder-cli/transfer";
import { failWhenAborted, type WorkspaceAction } from "./coderCommands.ts";
import { workspaceConnectionIsCurrent } from "./configChanges.ts";
import type { CoderHub } from "./hub.ts";
import {
  makeDeferredPromise,
  WorkspaceActionConflictError,
  type RunFork,
  type RunPromise,
  type WorkspaceActionClaim,
  type WorkspaceCloseClaim,
  type WorkspaceConnection,
  type WorkspaceConnectionClaim,
  type WorkspaceLifecycleState,
} from "./lifecycleState.ts";
import type { PortForwardManager } from "./portForwards.ts";
import { makeWorkspaceRpcBridge } from "./rpcBridge.ts";

const MAX_WORKSPACE_DIAGNOSTIC_EVENTS = 24;

export interface WorkspaceConnectionManagerOptions {
  readonly runPromise: RunPromise;
  readonly runFork: RunFork;
  /** Each connection's `coder ssh` child runs in a scope forked from the gateway's. */
  readonly gatewayScope: Scope.Scope;
  /** The gateway's current configuration. */
  readonly config: () => CoderProfileConfig;
  readonly isClosed: () => boolean;
  readonly coderInvocationOptions: (deploymentId: string) => CoderInvocationOptions;
  readonly hub: CoderHub;
  /** The browser socket attached to each workspace; a workspace action closes it. */
  readonly workspaceSockets: ReadonlyMap<string, WebSocket>;
  readonly portForwards: Pick<
    PortForwardManager,
    "portForwardLifecycle" | "ensurePortForward" | "stopPortForward"
  >;
  readonly openHelper: (
    invocation: CoderInvocation,
    hooks: { readonly onReady: () => void; readonly signal: AbortSignal },
  ) => Effect.Effect<CoderHelperConnection, unknown, Scope.Scope>;
  readonly helperBundlePath: string | undefined;
  readonly helperBundleHash: Effect.Effect<string | undefined, Error>;
  readonly installHelper: (
    input: Parameters<typeof installCoderHelper>[0],
  ) => Effect.Effect<void, unknown>;
  readonly runWorkspaceStart: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly runWorkspaceStop: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly runWorkspaceRestart: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly runWorkspaceUpdate: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
}

/**
 * The configured workspaces' lifecycles: the helper connection over `coder ssh`, workspace
 * actions, and each workspace's in-memory connection diagnostics.
 */
export function makeWorkspaceConnectionManager(deps: WorkspaceConnectionManagerOptions) {
  const {
    runPromise,
    runFork,
    gatewayScope,
    config,
    isClosed,
    coderInvocationOptions,
    hub,
    workspaceSockets,
    portForwards: { portForwardLifecycle, ensurePortForward, stopPortForward },
    openHelper,
    helperBundlePath,
    helperBundleHash,
    installHelper,
    runWorkspaceStart,
    runWorkspaceStop,
    runWorkspaceRestart,
    runWorkspaceUpdate,
  } = deps;
  const workspaceLifecycles = new Map<
    string,
    SynchronizedRef.SynchronizedRef<WorkspaceLifecycleState>
  >();
  const workspaceDiagnosticEvents = new Map<string, WorkspaceDiagnosticEvent[]>();
  const workspaceAttemptCounters = new Map<string, number>();
  let workspaceDiagnosticEventId = 0;
  const diagnosticEventsFor = (workspaceId: string): WorkspaceDiagnosticEvent[] => {
    const existing = workspaceDiagnosticEvents.get(workspaceId);
    if (existing !== undefined) return existing;
    const created: WorkspaceDiagnosticEvent[] = [];
    workspaceDiagnosticEvents.set(workspaceId, created);
    return created;
  };
  const beginDiagnosticPhase = (
    workspaceId: string,
    attempt: number,
    phase: WorkspaceDiagnosticPhase,
  ) => {
    const startedAt = Date.now();
    const id = ++workspaceDiagnosticEventId;
    const events = diagnosticEventsFor(workspaceId);
    events.push({ id, attempt, phase, status: "running", startedAt });
    if (events.length > MAX_WORKSPACE_DIAGNOSTIC_EVENTS) {
      events.splice(0, events.length - MAX_WORKSPACE_DIAGNOSTIC_EVENTS);
    }
    return (status: "completed" | "failed") => {
      const index = events.findIndex((event) => event.id === id);
      if (index === -1) return;
      events[index] = {
        id,
        attempt,
        phase,
        status,
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    };
  };
  const instrumentDiagnosticPhase = <A, E, R>(
    workspaceId: string,
    attempt: number,
    phase: WorkspaceDiagnosticPhase,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const finish = beginDiagnosticPhase(workspaceId, attempt, phase);
      return effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => finish(Exit.isSuccess(exit) ? "completed" : "failed")),
        ),
      );
    });
  const recordDiagnosticEvent = (
    workspaceId: string,
    attempt: number,
    phase: WorkspaceDiagnosticPhase,
  ) => beginDiagnosticPhase(workspaceId, attempt, phase)("completed");
  const workspaceLifecycle = (workspaceId: string) => {
    const existing = workspaceLifecycles.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = SynchronizedRef.makeUnsafe<WorkspaceLifecycleState>({
      _tag: "Disconnected",
      generation: 0,
    });
    workspaceLifecycles.set(workspaceId, created);
    return created;
  };
  const clearWorkspaceDiagnostics = () => {
    workspaceDiagnosticEvents.clear();
    workspaceAttemptCounters.clear();
  };

  const ensureWorkspaceConnection = async (workspaceId: string): Promise<WorkspaceConnection> => {
    if (isClosed()) throw new Error("Coder gateway is closed.");
    const lifecycle = workspaceLifecycle(workspaceId);
    const deferred = makeDeferredPromise<WorkspaceConnection>();
    const cancel = new AbortController();
    const claim = await runPromise(
      SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceConnectionClaim>(
        lifecycle,
        (state) => {
          switch (state._tag) {
            case "ShutdownFailed":
              return [{ _tag: "ShutdownFailed" as const, error: state.error }, state];
            case "Connected":
              return [
                {
                  _tag: "Existing" as const,
                  connection: { connection: state.connection, rpcBridge: state.rpcBridge },
                },
                state,
              ];
            case "Connecting":
              return [{ _tag: "Pending" as const, operation: state.operation }, state];
            case "Changing":
              return [{ _tag: "Changing" as const, operation: state.operation }, state];
            case "Disconnected":
              return [
                { _tag: "Start" as const, generation: state.generation },
                {
                  _tag: "Connecting" as const,
                  generation: state.generation,
                  operation: deferred.promise,
                  cancel,
                },
              ];
          }
        },
      ),
    );
    if (claim._tag === "ShutdownFailed") throw new Error(claim.error);
    if (claim._tag === "Existing") return claim.connection;
    if (claim._tag === "Pending") return claim.operation;
    if (claim._tag === "Changing") {
      await claim.operation;
      return ensureWorkspaceConnection(workspaceId);
    }

    const generation = claim.generation;
    const attempt = (workspaceAttemptCounters.get(workspaceId) ?? 0) + 1;
    workspaceAttemptCounters.set(workspaceId, attempt);
    const startIsCurrent = () => {
      const state = SynchronizedRef.getUnsafe(lifecycle);
      return (
        !isClosed() &&
        state._tag === "Connecting" &&
        state.generation === generation &&
        state.operation === deferred.promise
      );
    };
    const assertStartIsCurrent = () => {
      if (!startIsCurrent()) throw new Error("Coder workspace connection was cancelled.");
    };
    void runPromise(
      Effect.gen(function* () {
        const connectionConfig = config();
        const workspace = connectionConfig.workspaces.find((entry) => entry.id === workspaceId);
        const deployment =
          workspace === undefined
            ? undefined
            : connectionConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
        if (workspace === undefined || deployment === undefined) {
          return yield* Effect.fail(new Error("Unknown Coder workspace."));
        }
        const invocationOptions = coderInvocationOptions(deployment.id);
        const expectedBundleHash = yield* helperBundleHash;
        const helperInvocation = buildCoderHelperInvocation(deployment, workspace, {
          ...invocationOptions,
          ...(expectedBundleHash === undefined ? {} : { expectedBundleHash }),
        });
        const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
        // One `coder ssh` runs the preflight, checks the installed bundle, and starts the helper.
        // The preflight phase ends when the launch prints its ready sentinel.
        const launchHelper = Effect.suspend(() => {
          const finishPreflight = beginDiagnosticPhase(workspaceId, attempt, "preflight");
          let finishNegotiation: ((status: "completed" | "failed") => void) | undefined;
          const onReady = () => {
            if (finishNegotiation !== undefined) return;
            finishPreflight("completed");
            finishNegotiation = beginDiagnosticPhase(workspaceId, attempt, "negotiating_helper");
          };
          return openHelper(helperInvocation, { onReady, signal: cancel.signal }).pipe(
            Scope.provide(connectionScope),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) onReady();
                if (finishNegotiation !== undefined) {
                  finishNegotiation(Exit.isSuccess(exit) ? "completed" : "failed");
                  return;
                }
                const installRequired = Exit.findErrorOption(exit).pipe(
                  Option.exists((error) => error instanceof CoderHelperInstallRequiredError),
                );
                finishPreflight(installRequired ? "completed" : "failed");
              }),
            ),
          );
        });
        let acquired: CoderHelperConnection | undefined;
        return yield* Effect.gen(function* () {
          const connection = yield* launchHelper.pipe(
            Effect.catchIf(
              (error) =>
                error instanceof CoderHelperInstallRequiredError && helperBundlePath !== undefined,
              () =>
                Effect.gen(function* () {
                  yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
                  yield* instrumentDiagnosticPhase(
                    workspaceId,
                    attempt,
                    "installing_helper",
                    installHelper({
                      deployment,
                      workspace,
                      helperBundlePath: helperBundlePath!,
                      invocationOptions,
                    }).pipe(Effect.raceFirst(failWhenAborted(cancel.signal))),
                  );
                  yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
                  return yield* launchHelper;
                }),
            ),
          );
          acquired = connection;
          runFork(
            connection.closed.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const state = SynchronizedRef.getUnsafe(lifecycle);
                  if (
                    (state._tag === "Connected" || state._tag === "ShutdownFailed") &&
                    state.connection === connection
                  ) {
                    recordDiagnosticEvent(workspaceId, attempt, "disconnected");
                  }
                }),
              ),
              Effect.tap(() =>
                SynchronizedRef.update(lifecycle, (state) => {
                  if (state._tag === "Changing" && state.shutdownFailure?.connection === connection)
                    return { ...state, shutdownFailure: undefined };
                  if (
                    ((state._tag === "Connected" || state._tag === "ShutdownFailed") &&
                      state.connection === connection) ||
                    (state._tag === "Connecting" && state.operation === deferred.promise)
                  )
                    return { _tag: "Disconnected", generation: state.generation } as const;
                  return state;
                }),
              ),
              Effect.ensuring(Scope.close(connectionScope, Exit.void)),
            ),
          );
          if (!startIsCurrent()) {
            return yield* Effect.fail(new Error("Coder workspace connection was cancelled."));
          }
          if (!workspaceConnectionIsCurrent(connectionConfig, config(), workspaceId)) {
            return yield* Effect.fail(
              new Error("Coder workspace configuration changed while connecting."),
            );
          }
          const rpcBridge = yield* makeWorkspaceRpcBridge(connection).pipe(
            Scope.provide(connectionScope),
          );
          const connected = yield* SynchronizedRef.modify(lifecycle, (state) => {
            if (
              state._tag !== "Connecting" ||
              state.generation !== generation ||
              state.operation !== deferred.promise
            ) {
              return [false, state];
            }
            return [
              true,
              {
                _tag: "Connected" as const,
                generation,
                connection,
                rpcBridge,
                scope: connectionScope,
              },
            ];
          });
          if (!connected) {
            return yield* Effect.fail(new Error("Coder workspace connection was cancelled."));
          }
          recordDiagnosticEvent(workspaceId, attempt, "connected");
          // Coder: route hub requests to and from this helper while it is connected.
          const detachFromHub = hub.attach(workspaceId, connection);
          yield* Scope.addFinalizer(connectionScope, Effect.sync(detachFromHub));
          return { connection, rpcBridge } satisfies WorkspaceConnection;
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
                      return state._tag === "Changing"
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
          state._tag === "Connecting" && state.operation === deferred.promise
            ? ({ _tag: "Disconnected", generation: state.generation } as const)
            : state,
        ),
      ).then(
        () => deferred.reject(cause),
        () => deferred.reject(cause),
      );
    });
    return deferred.promise;
  };

  const closeWorkspaceConnection = async (workspaceId: string): Promise<void> => {
    const lifecycle = workspaceLifecycle(workspaceId);
    const deferred = makeDeferredPromise<void>();
    const claim = await runPromise(
      SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceCloseClaim>(lifecycle, (state) => {
        if (state._tag === "Changing")
          return [{ _tag: "Changing", operation: state.operation }, state];
        const generation = state.generation + 1;
        if (state._tag === "Disconnected")
          return [{ _tag: "Closed" }, { _tag: "Disconnected", generation }];
        return [
          {
            _tag: "Close",
            pending: state._tag === "Connecting" ? state.operation : undefined,
            cancel: state._tag === "Connecting" ? state.cancel : undefined,
            scope:
              state._tag === "Connected" || state._tag === "ShutdownFailed"
                ? state.scope
                : undefined,
            previous:
              state._tag === "Connected" || state._tag === "ShutdownFailed" ? state : undefined,
          },
          { _tag: "Changing", generation, action: "stop", operation: deferred.promise },
        ];
      }),
    );
    if (claim._tag === "Closed") return;
    if (claim._tag === "Changing") {
      await claim.operation;
      return closeWorkspaceConnection(workspaceId);
    }
    void (async () => {
      try {
        if (claim.previous) await runPromise(claim.previous.connection.close);
        if (claim.scope)
          await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
        claim.cancel?.abort();
        if (claim.pending)
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
            state._tag === "Changing" && state.operation === deferred.promise
              ? { _tag: "Disconnected" as const, generation: state.generation }
              : state,
          ),
        );
        recordDiagnosticEvent(
          workspaceId,
          workspaceAttemptCounters.get(workspaceId) ?? 1,
          "disconnected",
        );
        deferred.resolve(undefined);
      } catch (cause) {
        await runPromise(
          SynchronizedRef.update(lifecycle, (state) =>
            state._tag === "Changing" && state.operation === deferred.promise
              ? (state.shutdownFailure ??
                (claim.previous
                  ? {
                      ...claim.previous,
                      _tag: "ShutdownFailed" as const,
                      generation: state.generation,
                      error: "Coder child shutdown failed. Retry stopping it before reconnecting.",
                    }
                  : {
                      _tag: "Disconnected" as const,
                      generation: state.generation,
                    }))
              : state,
          ),
        );
        deferred.reject(cause);
      }
    })();
    return deferred.promise;
  };

  const runWorkspaceAction = (workspaceId: string, action: WorkspaceAction): Promise<void> => {
    const lifecycle = workspaceLifecycle(workspaceId);
    const deferred = makeDeferredPromise<void>();
    return runPromise(
      SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceActionClaim>(lifecycle, (state) => {
        if (state._tag === "Changing") {
          return [
            state.action === action
              ? ({ _tag: "Pending" as const, operation: state.operation } as const)
              : ({ _tag: "Conflict" as const, action: state.action } as const),
            state,
          ];
        }
        return [
          {
            _tag: "Start" as const,
            pending: state._tag === "Connecting" ? state.operation : undefined,
            cancel: state._tag === "Connecting" ? state.cancel : undefined,
            scope:
              state._tag === "Connected" || state._tag === "ShutdownFailed"
                ? state.scope
                : undefined,
            previous:
              state._tag === "Connected" || state._tag === "ShutdownFailed" ? state : undefined,
          },
          {
            _tag: "Changing" as const,
            generation: state.generation + 1,
            action,
            operation: deferred.promise,
          },
        ];
      }),
    ).then((claim) => {
      if (claim._tag === "Pending") return claim.operation;
      if (claim._tag === "Conflict") {
        const activeAction =
          claim.action === "start"
            ? "starting"
            : claim.action === "stop"
              ? "stopping"
              : claim.action === "restart"
                ? "restarting"
                : "updating";
        throw new WorkspaceActionConflictError(`Coder workspace is already ${activeAction}.`);
      }
      void (async () => {
        let helperClosed = false;
        try {
          const workspace = config().workspaces.find((entry) => entry.id === workspaceId);
          const deployment =
            workspace === undefined
              ? undefined
              : config().deployments.find((entry) => entry.id === workspace.deploymentId);
          if (workspace === undefined || deployment === undefined) {
            throw new Error("Unknown Coder workspace.");
          }

          const portForwardIds =
            config()
              .portForwards?.filter((entry) => entry.workspaceId === workspaceId)
              .map((entry) => entry.id) ?? [];
          workspaceSockets.get(workspaceId)?.close(1012, "Coder workspace state is changing.");
          if (claim.previous) await runPromise(claim.previous.connection.close);
          helperClosed = true;
          if (claim.scope !== undefined) {
            await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
          }
          claim.cancel?.abort();
          if (claim.pending !== undefined)
            await claim.pending.catch((cause) => {
              const state = SynchronizedRef.getUnsafe(lifecycle);
              if (
                state._tag === "ShutdownFailed" ||
                ("shutdownFailure" in state && state.shutdownFailure)
              )
                throw cause;
            });
          await Promise.all(portForwardIds.map(stopPortForward));
          if (isClosed()) throw new Error("Coder gateway is closed.");

          const invocationOptions = coderInvocationOptions(deployment.id);
          try {
            if (action === "start") {
              await runPromise(
                runWorkspaceStart(
                  buildCoderStartWorkspaceInvocation(deployment, workspace, invocationOptions),
                ),
              );
            } else if (action === "stop") {
              await runPromise(
                runWorkspaceStop(
                  buildCoderStopWorkspaceInvocation(deployment, workspace, invocationOptions),
                ),
              );
            } else if (action === "restart") {
              await runPromise(
                runWorkspaceRestart(
                  buildCoderRestartWorkspaceInvocation(deployment, workspace, invocationOptions),
                ),
              );
            } else {
              await runPromise(
                runWorkspaceUpdate(
                  buildCoderUpdateWorkspaceInvocation(deployment, workspace, invocationOptions),
                ),
              );
            }
          } catch (cause) {
            await Promise.all(
              portForwardIds.map((portForwardId) =>
                runPromise(
                  SynchronizedRef.update(
                    portForwardLifecycle(portForwardId),
                    (state) =>
                      ({
                        _tag: "Failed",
                        generation: state.generation,
                        error: `Coder workspace ${action} failed. Restart this forward after the workspace recovers.`,
                      }) as const,
                  ),
                ),
              ),
            );
            throw cause;
          }

          if (isClosed()) throw new Error("Coder gateway is closed.");
          if (action === "stop") {
            await Promise.all(
              portForwardIds.map((portForwardId) =>
                runPromise(
                  SynchronizedRef.update(
                    portForwardLifecycle(portForwardId),
                    (state) =>
                      ({
                        _tag: "WorkspaceStopped",
                        generation: state.generation,
                      }) as const,
                  ),
                ),
              ),
            );
          } else {
            await Promise.allSettled(
              portForwardIds.map((portForwardId) => ensurePortForward(portForwardId)),
            );
          }
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Changing" && state.operation === deferred.promise
                ? ({ _tag: "Disconnected", generation: state.generation } as const)
                : state,
            ),
          );
          deferred.resolve(undefined);
        } catch (cause) {
          try {
            await runPromise(
              SynchronizedRef.update(lifecycle, (state) =>
                state._tag === "Changing" && state.operation === deferred.promise
                  ? (state.shutdownFailure ??
                    (!helperClosed && claim.previous
                      ? {
                          ...claim.previous,
                          _tag: "ShutdownFailed" as const,
                          generation: state.generation,
                          error:
                            "Coder helper shutdown failed. Retry stopping it before reconnecting.",
                        }
                      : ({ _tag: "Disconnected", generation: state.generation } as const)))
                  : state,
              ),
            );
          } finally {
            deferred.reject(cause);
          }
        }
      })();
      return deferred.promise;
    });
  };

  return {
    workspaceLifecycles,
    workspaceLifecycle,
    diagnosticEventsFor,
    clearWorkspaceDiagnostics,
    ensureWorkspaceConnection,
    closeWorkspaceConnection,
    runWorkspaceAction,
  };
}
