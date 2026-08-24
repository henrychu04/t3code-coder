import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  connectCoderWorkspace,
  discoverCoderWorkspaces,
  disconnectCoderWorkspace,
  loadCoderConfig,
  loadCoderWorkspaceLatency,
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
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

interface CoderContextValue {
  readonly config: CoderProfileConfig;
  readonly connectionErrors: Readonly<Record<string, string>>;
  readonly workspaceRuntime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>;
  readonly workspaceLatencyMs: Readonly<Record<string, number>>;
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
      { status: "unknown", updateAvailable: false, healthy: null },
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
  const [connectedWorkspaceIds, setConnectedWorkspaceIds] = useState<readonly string[]>([]);
  const [workspaceLatencyMs, setWorkspaceLatencyMs] = useState<Readonly<Record<string, number>>>(
    {},
  );

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
      setConnectedWorkspaceIds((current) =>
        current.includes(workspaceId) ? current : [...current, workspaceId],
      );
      return descriptor;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (connectionAttemptGenerations.current[workspaceId] === generation) {
        setConnectedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceId));
        setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
      }
      throw cause;
    }
  }, []);

  useEffect(() => {
    if (connectedWorkspaceIds.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      const measurements = await Promise.all(
        connectedWorkspaceIds.map(async (workspaceId) => {
          try {
            return [workspaceId, await loadCoderWorkspaceLatency(workspaceId)] as const;
          } catch {
            return [workspaceId, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setWorkspaceLatencyMs((current) => {
        const next: Record<string, number> = { ...current };
        let changed = false;
        for (const [workspaceId, latencyMs] of measurements) {
          if (latencyMs === null || current[workspaceId] === latencyMs) continue;
          next[workspaceId] = latencyMs;
          changed = true;
        }
        return changed ? next : current;
      });
      timer = window.setTimeout(() => void refresh(), 1_000);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connectedWorkspaceIds]);

  const applyWorkspaceRuntime = useCallback(
    (runtime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>) => {
      setWorkspaceRuntime(runtime);
      const inactiveWorkspaceIds = new Set<string>();
      for (const [workspaceId, status] of Object.entries(runtime)) {
        if (
          status.status !== "stopped" &&
          status.status !== "starting" &&
          status.status !== "unavailable"
        ) {
          continue;
        }
        connectionAttemptGenerations.current[workspaceId] =
          (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
        inactiveWorkspaceIds.add(workspaceId);
      }
      setConnectedWorkspaceIds((current) =>
        current.some((workspaceId) => inactiveWorkspaceIds.has(workspaceId))
          ? current.filter((workspaceId) => !inactiveWorkspaceIds.has(workspaceId))
          : current,
      );
      setWorkspaceLatencyMs((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([workspaceId]) => !inactiveWorkspaceIds.has(workspaceId)),
        );
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
      setConnectionErrors((current) => discardInactiveWorkspaceConnectionErrors(current, runtime));
    },
    [],
  );

  useEffect(() => {
    if (config === null) return;
    setCoderWorkspaceOrder(config.workspaces.map((workspace) => workspace.id));
    let cancelled = false;
    let retryTimer: number | undefined;
    const connectAvailableWorkspaces = async (): Promise<void> => {
      const runtime = await readWorkspaceRuntime(config);
      if (cancelled) return;
      applyWorkspaceRuntime(runtime);
      let hasPendingWorkspaceStatus = false;
      for (const workspace of config.workspaces) {
        const status = runtime[workspace.id]?.status;
        if (status === "stopped" || status === "starting" || status === "unavailable") {
          removeCoderWorkspaceEnvironment(workspace.id);
          hasPendingWorkspaceStatus ||= status === "starting" || status === "unavailable";
          continue;
        }
        void connectWorkspace(workspace.id).catch(() => undefined);
      }
      if (hasPendingWorkspaceStatus) {
        retryTimer = window.setTimeout(() => void connectAvailableWorkspaces(), 2_000);
      }
    };
    void connectAvailableWorkspaces();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [applyWorkspaceRuntime, config, connectWorkspace]);

  const refreshWorkspaceRuntime = useCallback(async () => {
    if (config === null) return {};
    const runtime = await readWorkspaceRuntime(config);
    applyWorkspaceRuntime(runtime);
    return runtime;
  }, [applyWorkspaceRuntime, config]);

  const saveConfig = useCallback(async (nextConfig: CoderProfileConfig) => {
    const saved = await saveCoderConfig(nextConfig);
    setConfig(saved);
    return saved;
  }, []);

  const disconnectWorkspace = useCallback(async (workspaceId: string) => {
    connectionAttemptGenerations.current[workspaceId] =
      (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
    await disconnectCoderWorkspace(workspaceId);
    removeCoderWorkspaceEnvironment(workspaceId);
    setConnectedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceId));
    setWorkspaceLatencyMs((current) => {
      if (current[workspaceId] === undefined) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
    setConnectionErrors((current) => {
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  }, []);

  const completeWorkspaceAction = useCallback(
    async (workspaceId: string, action: (workspaceId: string) => Promise<void>) => {
      removeCoderWorkspaceEnvironment(workspaceId);
      setConnectedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceId));
      setWorkspaceLatencyMs((current) => {
        if (current[workspaceId] === undefined) return current;
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      const actionGeneration = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
      connectionAttemptGenerations.current[workspaceId] = actionGeneration;
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
        },
      }));
      try {
        await action(workspaceId);
      } catch (cause) {
        if (connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
        }
        void refreshWorkspaceRuntime();
        throw cause;
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
      setConnectedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceId));
      setWorkspaceLatencyMs((current) => {
        if (current[workspaceId] === undefined) return current;
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      const actionGeneration = (connectionAttemptGenerations.current[workspaceId] ?? 0) + 1;
      connectionAttemptGenerations.current[workspaceId] = actionGeneration;
      setConnectionErrors((current) => {
        if (current[workspaceId] === undefined) return current;
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      try {
        await stopCoderWorkspace(workspaceId);
        setWorkspaceRuntime((current) => ({
          ...current,
          [workspaceId]: {
            status: "stopped",
            updateAvailable: current[workspaceId]?.updateAvailable ?? false,
            healthy: null,
          },
        }));
      } catch (cause) {
        if (connectionAttemptGenerations.current[workspaceId] === actionGeneration) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
        }
        void refreshWorkspaceRuntime();
        throw cause;
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
            workspaceLatencyMs,
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
      workspaceLatencyMs,
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
