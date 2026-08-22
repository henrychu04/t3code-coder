import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  connectCoderWorkspace,
  disconnectCoderWorkspace,
  loadCoderConfig,
  saveCoderConfig,
  type CoderProfileConfig,
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
  readonly saveConfig: (config: CoderProfileConfig) => Promise<CoderProfileConfig>;
  readonly connectWorkspace: (workspaceId: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly disconnectWorkspace: (workspaceId: string) => Promise<void>;
}

const CoderContext = createContext<CoderContextValue | null>(null);

export function useCoder(): CoderContextValue {
  const value = useContext(CoderContext);
  if (value === null) throw new Error("Coder context is unavailable.");
  return value;
}

export function CoderBootstrap({ app }: { readonly app: ReactNode }) {
  const [config, setConfig] = useState<CoderProfileConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionErrors, setConnectionErrors] = useState<Readonly<Record<string, string>>>({});

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
    try {
      const descriptor = await connectCoderWorkspace(workspaceId);
      setCoderWorkspaceEnvironment(workspaceId, descriptor);
      setConnectionErrors((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      return descriptor;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConnectionErrors((current) => ({ ...current, [workspaceId]: message }));
      throw cause;
    }
  }, []);

  useEffect(() => {
    if (config === null) return;
    setCoderWorkspaceOrder(config.workspaces.map((workspace) => workspace.id));
    let cancelled = false;
    for (const workspace of config.workspaces) {
      void connectCoderWorkspace(workspace.id)
        .then((descriptor) => {
          if (!cancelled) setCoderWorkspaceEnvironment(workspace.id, descriptor);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionErrors((current) => ({ ...current, [workspace.id]: message }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [config]);

  const saveConfig = useCallback(async (nextConfig: CoderProfileConfig) => {
    const saved = await saveCoderConfig(nextConfig);
    setConfig(saved);
    return saved;
  }, []);

  const disconnectWorkspace = useCallback(async (workspaceId: string) => {
    await disconnectCoderWorkspace(workspaceId);
    removeCoderWorkspaceEnvironment(workspaceId);
    setConnectionErrors((current) => {
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  }, []);

  const value = useMemo<CoderContextValue | null>(
    () =>
      config === null
        ? null
        : { config, connectionErrors, saveConfig, connectWorkspace, disconnectWorkspace },
    [config, connectWorkspace, connectionErrors, disconnectWorkspace, saveConfig],
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
