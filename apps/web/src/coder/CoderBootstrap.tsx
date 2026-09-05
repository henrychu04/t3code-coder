import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  connectCoderWorkspace,
  discoverCoderWorkspaces,
  disconnectCoderWorkspace,
  loadCoderConfig,
  restartCoderWorkspace,
  saveCoderConfig,
  startCoderWorkspace,
  stopCoderWorkspace,
  updateCoderWorkspace,
  type CoderProfileConfig,
  type CoderWorkspaceRuntimeStatus,
} from "./api";
import {
  removeCoderWorkspaceEnvironment,
  setCoderWorkspaceEnvironment,
  setCoderWorkspaceOrder,
} from "./environmentStore";
import {
  readCoderWorkspaceNetwork,
  startCoderWorkspaceNetworkSampler,
  subscribeCoderWorkspaceNetwork,
  type CoderWorkspaceNetworkState,
} from "./workspaceNetwork";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

interface CoderContextValue {
  readonly config: CoderProfileConfig;
  readonly connectionErrors: Readonly<Record<string, string>>;
  readonly workspaceRuntime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>;
  readonly workspaceNetwork: Readonly<Record<string, CoderWorkspaceNetworkState>>;
  readonly saveConfig: (config: CoderProfileConfig) => Promise<CoderProfileConfig>;
  readonly connectWorkspace: (workspaceId: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly disconnectWorkspace: (workspaceId: string) => Promise<void>;
  readonly refreshWorkspaceRuntime: () => Promise<
    Readonly<Record<string, CoderWorkspaceRuntimeStatus>>
  >;
  readonly startWorkspace: (workspaceId: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly stopWorkspace: (workspaceId: string) => Promise<void>;
  readonly restartWorkspace: (workspaceId: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly updateWorkspace: (workspaceId: string) => Promise<ExecutionEnvironmentDescriptor>;
}

const STABLE_RUNTIME_REFRESH_MS = 60_000;

export function workspaceRuntimeRetryDelayMs(retryCount: number): number {
  return [2_000, 4_000, 8_000, 16_000, 30_000][Math.min(Math.max(0, retryCount), 4)]!;
}

const CoderContext = createContext<CoderContextValue | null>(null);

export async function readWorkspaceRuntime(
  config: CoderProfileConfig,
): Promise<Readonly<Record<string, CoderWorkspaceRuntimeStatus>>> {
  const discoveredByDeployment = await Promise.all(
    config.deployments.map(async (deployment) => {
      try {
        return {
          deploymentId: deployment.id,
          workspaces: await discoverCoderWorkspaces(deployment.id),
        };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return {
          deploymentId: deployment.id,
          workspaces: [],
          error: `Could not fetch workspace status.${detail.length === 0 ? "" : ` ${detail}`}`,
        };
      }
    }),
  );
  const next: Record<string, CoderWorkspaceRuntimeStatus> = Object.fromEntries(
    config.workspaces.map((workspace) => [
      workspace.id,
      {
        status: "unknown",
        updateAvailable: false,
        healthy: null,
        autostopAt: null,
        requiredStopAt: null,
      },
    ]),
  );
  for (const workspace of config.workspaces) {
    const deployment = discoveredByDeployment.find(
      (entry) => entry.deploymentId === workspace.deploymentId,
    );
    if (deployment?.error !== undefined) {
      next[workspace.id] = {
        status: "unavailable",
        updateAvailable: false,
        healthy: null,
        autostopAt: null,
        requiredStopAt: null,
        error: deployment.error,
      };
      continue;
    }
    const discovered = deployment?.workspaces.find(
      (entry) =>
        entry.target === workspace.workspace ||
        (!workspace.workspace.includes("/") && entry.name === workspace.workspace),
    );
    if (discovered !== undefined) {
      next[workspace.id] = {
        status: discovered.status,
        updateAvailable: discovered.updateAvailable,
        healthy: discovered.healthy,
        autostopAt: discovered.autostopAt,
        requiredStopAt: discovered.requiredStopAt,
      };
    }
  }
  return next;
}

export function discardInactiveWorkspaceConnectionErrors(
  errors: Readonly<Record<string, string>>,
  runtime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>,
): Readonly<Record<string, string>> {
  const next = { ...errors };
  let changed = false;
  for (const workspaceId of Object.keys(errors)) {
    const status = runtime[workspaceId]?.status;
    if (status !== "stopped" && status !== "starting" && status !== "unavailable") continue;
    delete next[workspaceId];
    changed = true;
  }
  return changed ? next : errors;
}

export function useCoder(): CoderContextValue {
  const value = useContext(CoderContext);
  if (value === null) throw new Error("Coder context is unavailable.");
  return value;
}

export function CoderBootstrap({ app }: { readonly app: ReactNode }) {
  const [config, setConfig] = useState<CoderProfileConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionErrors, setConnectionErrors] = useState<Readonly<Record<string, string>>>({});
  const connectionAttemptGenerations = useRef<Record<string, number>>({});
  const [workspaceRuntime, setWorkspaceRuntime] = useState<
    Readonly<Record<string, CoderWorkspaceRuntimeStatus>>
  >({});
  const workspaceNetwork = useSyncExternalStore(
    subscribeCoderWorkspaceNetwork,
    readCoderWorkspaceNetwork,
    readCoderWorkspaceNetwork,
  );
  const runtimeRequestGeneration = useRef(0);
  const pendingWorkspaceActions = useRef(new Map<string, number>());
  const configSaveGeneration = useRef(0);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setConfig(await loadCoderConfig());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    startCoderWorkspaceNetworkSampler();
  }, []);

  const connectWorkspace = useCallback(async (workspaceId: string) => {
    const generation = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
    connectionAttemptGenerations.current[workspaceId] = generation;
    setConnectionErrors((current) => {
      if (current[workspaceId] === undefined) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
    try {
      const descriptor = await connectCoderWorkspace(workspaceId);
      if (connectionAttemptGenerations.current[workspaceId] !== generation) return descriptor;
      setCoderWorkspaceEnvironment(workspaceId, descriptor);

      return descriptor;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (connectionAttemptGenerations.current[workspaceId] === generation) {
        setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
      }
      throw cause;
    }
  }, []);

  const applyWorkspaceRuntime = useCallback(
    (runtime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>) => {
      const applicableRuntime = Object.fromEntries(
        Object.entries(runtime).filter(([id]) => !pendingWorkspaceActions.current.has(id)),
      );
      setWorkspaceRuntime((current) => ({ ...current, ...applicableRuntime }));
      for (const [workspaceId, status] of Object.entries(applicableRuntime)) {
        if (
          status.status !== "stopped" &&
          status.status !== "starting" &&
          status.status !== "unavailable"
        ) {
          continue;
        }
        connectionAttemptGenerations.current[workspaceId] =
          (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
        removeCoderWorkspaceEnvironment(workspaceId);
      }

      setConnectionErrors((current) =>
        discardInactiveWorkspaceConnectionErrors(current, applicableRuntime),
      );
    },
    [],
  );

  useEffect(() => {
    if (config === null) return;
    const allowedWorkspaceIds = new Set(config.workspaces.map((workspace) => workspace.id));
    setCoderWorkspaceOrder([...allowedWorkspaceIds]);
    setWorkspaceRuntime((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => allowedWorkspaceIds.has(id))),
    );
    setConnectionErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => allowedWorkspaceIds.has(id))),
    );
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryCount = 0;
    const connectAvailableWorkspaces = async (): Promise<void> => {
      retryTimer = undefined;
      const requestGeneration = ++runtimeRequestGeneration.current;
      const runtime = await readWorkspaceRuntime(config);
      if (cancelled) return;
      if (requestGeneration !== runtimeRequestGeneration.current) {
        retryTimer = window.setTimeout(
          () => void connectAvailableWorkspaces(),
          STABLE_RUNTIME_REFRESH_MS,
        );
        return;
      }
      applyWorkspaceRuntime(runtime);
      let hasPendingWorkspaceStatus = false;
      for (const workspace of config.workspaces) {
        if (pendingWorkspaceActions.current.has(workspace.id)) continue;
        const status = runtime[workspace.id]?.status;
        if (status === "stopped" || status === "starting" || status === "unavailable") {
          removeCoderWorkspaceEnvironment(workspace.id);
          hasPendingWorkspaceStatus ||= status === "starting" || status === "unavailable";
          continue;
        }
        void connectWorkspace(workspace.id).catch(() => undefined);
      }
      if (hasPendingWorkspaceStatus) {
        retryTimer = window.setTimeout(
          () => void connectAvailableWorkspaces(),
          workspaceRuntimeRetryDelayMs(retryCount),
        );
        retryCount += 1;
      } else {
        retryCount = 0;
        retryTimer = window.setTimeout(
          () => void connectAvailableWorkspaces(),
          STABLE_RUNTIME_REFRESH_MS,
        );
      }
    };
    const wake = () => {
      if (document.visibilityState !== "visible" || retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      retryCount = 0;
      void connectAvailableWorkspaces();
    };
    document.addEventListener("visibilitychange", wake);
    void connectAvailableWorkspaces();
    return () => {
      cancelled = true;
      runtimeRequestGeneration.current += 1;
      for (const workspace of config.workspaces) {
        connectionAttemptGenerations.current[workspace.id] =
          (connectionAttemptGenerations.current[workspace.id] ?? 0) + 1;
      }
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [applyWorkspaceRuntime, config, connectWorkspace]);

  const refreshWorkspaceRuntime = useCallback(async () => {
    if (config === null) return {};
    const requestGeneration = ++runtimeRequestGeneration.current;
    const runtime = await readWorkspaceRuntime(config);
    if (requestGeneration === runtimeRequestGeneration.current) applyWorkspaceRuntime(runtime);
    return runtime;
  }, [applyWorkspaceRuntime, config]);

  const saveConfig = useCallback(async (nextConfig: CoderProfileConfig) => {
    runtimeRequestGeneration.current += 1;
    const generation = ++configSaveGeneration.current;
    const saved = await saveCoderConfig(nextConfig);
    if (generation === configSaveGeneration.current) setConfig(saved);
    return saved;
  }, []);

  const disconnectWorkspace = useCallback(async (workspaceId: string) => {
    runtimeRequestGeneration.current += 1;
    const generation = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
    connectionAttemptGenerations.current[workspaceId] = generation;
    await disconnectCoderWorkspace(workspaceId);
    if (connectionAttemptGenerations.current[workspaceId] !== generation) return;
    removeCoderWorkspaceEnvironment(workspaceId);

    setConnectionErrors((current) => {
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  }, []);

  const completeWorkspaceAction = useCallback(
    async (workspaceId: string, action: (workspaceId: string) => Promise<void>) => {
      removeCoderWorkspaceEnvironment(workspaceId);

      runtimeRequestGeneration.current += 1;
      const actionGeneration = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
      connectionAttemptGenerations.current[workspaceId] = actionGeneration;
      pendingWorkspaceActions.current.set(workspaceId, actionGeneration);
      setConnectionErrors((current) => {
        if (current[workspaceId] === undefined) return current;
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setWorkspaceRuntime((current) => ({
        ...current,
        [workspaceId]: {
          status: "starting",
          updateAvailable: current[workspaceId]?.updateAvailable ?? false,
          healthy: null,
          autostopAt: current[workspaceId]?.autostopAt ?? null,
          requiredStopAt: current[workspaceId]?.requiredStopAt ?? null,
        },
      }));
      let failed = false;
      try {
        await action(workspaceId);
      } catch (cause) {
        if (connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
        }
        failed = true;
        throw cause;
      } finally {
        if (pendingWorkspaceActions.current.get(workspaceId) === actionGeneration) {
          pendingWorkspaceActions.current.delete(workspaceId);
          runtimeRequestGeneration.current += 1;
          if (failed && connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
            void refreshWorkspaceRuntime();
          }
        }
      }
      if (connectionAttemptGenerations.current[workspaceId] !== actionGeneration) {
        throw new Error("Workspace action was superseded.");
      }
      try {
        const descriptor = await connectWorkspace(workspaceId);
        void refreshWorkspaceRuntime();
        return descriptor;
      } catch (cause) {
        void refreshWorkspaceRuntime();
        throw cause;
      }
    },
    [connectWorkspace, refreshWorkspaceRuntime],
  );

  const startWorkspace = useCallback(
    (workspaceId: string) => completeWorkspaceAction(workspaceId, startCoderWorkspace),
    [completeWorkspaceAction],
  );
  const stopWorkspace = useCallback(
    async (workspaceId: string) => {
      removeCoderWorkspaceEnvironment(workspaceId);

      runtimeRequestGeneration.current += 1;
      const actionGeneration = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
      connectionAttemptGenerations.current[workspaceId] = actionGeneration;
      pendingWorkspaceActions.current.set(workspaceId, actionGeneration);
      setConnectionErrors((current) => {
        if (current[workspaceId] === undefined) return current;
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      let failed = false;
      try {
        await stopCoderWorkspace(workspaceId);
        if (connectionAttemptGenerations.current[workspaceId] !== actionGeneration) return;
        setWorkspaceRuntime((current) => ({
          ...current,
          [workspaceId]: {
            status: "stopped",
            updateAvailable: current[workspaceId]?.updateAvailable ?? false,
            healthy: null,
            autostopAt: null,
            requiredStopAt: null,
          },
        }));
      } catch (cause) {
        if (connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
        }
        failed = true;
        throw cause;
      } finally {
        if (pendingWorkspaceActions.current.get(workspaceId) === actionGeneration) {
          pendingWorkspaceActions.current.delete(workspaceId);
          runtimeRequestGeneration.current += 1;
          if (failed && connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
            void refreshWorkspaceRuntime();
          }
        }
      }
    },
    [refreshWorkspaceRuntime],
  );
  const restartWorkspace = useCallback(
    (workspaceId: string) => completeWorkspaceAction(workspaceId, restartCoderWorkspace),
    [completeWorkspaceAction],
  );
  const updateWorkspace = useCallback(
    (workspaceId: string) => completeWorkspaceAction(workspaceId, updateCoderWorkspace),
    [completeWorkspaceAction],
  );

  const value = useMemo<CoderContextValue | null>(
    () =>
      config === null
        ? null
        : {
            config,
            connectionErrors,
            workspaceRuntime,
            workspaceNetwork,
            saveConfig,
            connectWorkspace,
            disconnectWorkspace,
            refreshWorkspaceRuntime,
            startWorkspace,
            stopWorkspace,
            restartWorkspace,
            updateWorkspace,
          },
    [
      config,
      connectWorkspace,
      connectionErrors,
      disconnectWorkspace,
      refreshWorkspaceRuntime,
      restartWorkspace,
      saveConfig,
      startWorkspace,
      stopWorkspace,
      updateWorkspace,
      workspaceRuntime,
      workspaceNetwork,
    ],
  );

  if (value === null) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <div className="max-w-md text-center">
          <p>{loadError ?? "Starting T3 Coder…"}</p>
          {loadError ? (
            <button
              className="mt-4 rounded-md border px-3 py-2 text-sm"
              onClick={() => void reload()}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  return <CoderContext.Provider value={value}>{app}</CoderContext.Provider>;
}
