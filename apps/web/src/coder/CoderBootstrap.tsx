import { useEffect, useState, type ReactNode } from "react";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { writePrimaryEnvironmentDescriptor } from "../environments/primary";

interface DeploymentProfile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly executable?: string;
}

interface WorkspaceProfile {
  readonly id: string;
  readonly name: string;
  readonly deploymentId: string;
  readonly workspace: string;
  readonly workspaceRoot: string;
}

interface CoderProfileConfig {
  readonly version: 1;
  readonly deployments: readonly DeploymentProfile[];
  readonly workspaces: readonly WorkspaceProfile[];
}

interface DiscoveredWorkspace {
  readonly name: string;
  readonly target: string;
}

const emptyConfig: CoderProfileConfig = { version: 1, deployments: [], workspaces: [] };

async function readResponse(response: Response): Promise<Response> {
  if (!response.ok)
    throw new Error((await response.text()) || `Request failed (${response.status}).`);
  return response;
}

function workspaceFromLocation(): string | null {
  return new URL(window.location.href).searchParams.get("workspace");
}

export function CoderBootstrap({ app }: { readonly app: ReactNode }) {
  const workspaceId = workspaceFromLocation();
  const [config, setConfig] = useState<CoderProfileConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config", { cache: "no-store" })
      .then(readResponse)
      .then((response) => response.json() as Promise<CoderProfileConfig>)
      .then(async (loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        if (workspaceId === null) return;
        const connected = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/connection`,
          {
            method: "POST",
          },
        ).then(readResponse);
        const result = (await connected.json()) as {
          readonly info: { readonly environment: ExecutionEnvironmentDescriptor };
        };
        writePrimaryEnvironmentDescriptor(result.info.environment);
        if (!cancelled) setReady(true);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (workspaceId !== null && ready) {
    return (
      <>
        {app}
        <button
          className="fixed bottom-3 left-3 z-[1000] rounded-md border bg-background px-3 py-1.5 text-xs shadow"
          onClick={() => window.location.assign("/")}
          type="button"
        >
          Coder workspaces
        </button>
      </>
    );
  }

  if (config === null) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <p>{error ?? "Loading Coder workspaces…"}</p>
      </main>
    );
  }

  return <WorkspaceManager config={config} initialError={error} />;
}

function WorkspaceManager({
  config: initialConfig,
  initialError,
}: {
  readonly config: CoderProfileConfig;
  readonly initialError: string | null;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [error, setError] = useState(initialError);
  const [saving, setSaving] = useState(false);
  const [authenticating, setAuthenticating] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoveredByDeployment, setDiscoveredByDeployment] = useState<
    Readonly<Record<string, readonly DiscoveredWorkspace[]>>
  >({});

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      }).then(readResponse);
      setConfig((await response.json()) as CoderProfileConfig);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">T3 Coder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Claude runs inside the selected Coder workspace. Coder CLI owns authentication.
          </p>
        </div>

        {error ? <p className="rounded-md border border-destructive p-3 text-sm">{error}</p> : null}

        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">Coder deployments</h2>
          {config.deployments.map((deployment, index) => (
            <div
              className="grid gap-2 md:grid-cols-[1fr_1fr_2fr_auto_auto]"
              key={deployment.id || index}
            >
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Deployment id"
                placeholder="deployment-id"
                value={deployment.id}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    deployments: config.deployments.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, id: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Deployment name"
                placeholder="Goldman Coder"
                value={deployment.name}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    deployments: config.deployments.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Coder URL"
                placeholder="https://coder.example.com"
                value={deployment.url}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    deployments: config.deployments.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, url: event.target.value } : entry,
                    ),
                  })
                }
              />
              <button
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={saving || authenticating !== null || deployment.id.trim().length === 0}
                onClick={async () => {
                  if (!(await save())) return;
                  setAuthenticating(deployment.id);
                  setError(null);
                  try {
                    await fetch(`/api/deployments/${encodeURIComponent(deployment.id)}/login`, {
                      method: "POST",
                    }).then(readResponse);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setAuthenticating(null);
                  }
                }}
                type="button"
              >
                {authenticating === deployment.id ? "Authenticating…" : "Coder login"}
              </button>
              <button
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={saving || discovering !== null || deployment.id.trim().length === 0}
                onClick={async () => {
                  if (!(await save())) return;
                  setDiscovering(deployment.id);
                  setError(null);
                  try {
                    const response = await fetch(
                      `/api/deployments/${encodeURIComponent(deployment.id)}/workspaces`,
                      { method: "POST" },
                    ).then(readResponse);
                    const result = (await response.json()) as {
                      readonly workspaces: readonly DiscoveredWorkspace[];
                    };
                    setDiscoveredByDeployment((current) => ({
                      ...current,
                      [deployment.id]: result.workspaces,
                    }));
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setDiscovering(null);
                  }
                }}
                type="button"
              >
                {discovering === deployment.id ? "Discovering…" : "Discover workspaces"}
              </button>
            </div>
          ))}
          <button
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() =>
              setConfig({
                ...config,
                deployments: [
                  ...config.deployments,
                  { id: `coder-${config.deployments.length + 1}`, name: "", url: "" },
                ],
              })
            }
            type="button"
          >
            Add deployment
          </button>
        </section>

        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">Projects</h2>
          {config.workspaces.map((workspace, index) => (
            <div
              className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_2fr_2fr_auto]"
              key={workspace.id || index}
            >
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Workspace id"
                placeholder="project-id"
                value={workspace.id}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, id: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Project name"
                placeholder="Equities"
                value={workspace.name}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  })
                }
              />
              <select
                className="rounded-md border bg-background px-3 py-2"
                aria-label="Coder deployment"
                value={workspace.deploymentId}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, deploymentId: event.target.value } : entry,
                    ),
                  })
                }
              >
                <option value="">Select deployment</option>
                {config.deployments.map((deployment) => (
                  <option key={deployment.id} value={deployment.id}>
                    {deployment.name || deployment.id}
                  </option>
                ))}
              </select>
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Coder workspace"
                list={`coder-workspaces-${workspace.deploymentId}`}
                placeholder="owner/workspace"
                value={workspace.workspace}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, workspace: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                className="rounded-md border bg-transparent px-3 py-2"
                aria-label="Linux workspace root"
                placeholder="/workspace/project"
                value={workspace.workspaceRoot}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.map((entry, entryIndex) =>
                      entryIndex === index
                        ? { ...entry, workspaceRoot: event.target.value }
                        : entry,
                    ),
                  })
                }
              />
              <button
                className="rounded-md border px-3 py-2 text-sm"
                onClick={() =>
                  setConfig({
                    ...config,
                    workspaces: config.workspaces.filter((_, entryIndex) => entryIndex !== index),
                  })
                }
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
          {config.deployments.map((deployment) => (
            <datalist id={`coder-workspaces-${deployment.id}`} key={deployment.id}>
              {(discoveredByDeployment[deployment.id] ?? []).map((workspace) => (
                <option key={workspace.target} value={workspace.target}>
                  {workspace.name}
                </option>
              ))}
            </datalist>
          ))}
          <button
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() =>
              setConfig({
                ...config,
                workspaces: [
                  ...config.workspaces,
                  {
                    id: `project-${config.workspaces.length + 1}`,
                    name: "",
                    deploymentId: config.deployments[0]?.id ?? "",
                    workspace: "",
                    workspaceRoot: "",
                  },
                ],
              })
            }
            type="button"
          >
            Add project
          </button>
        </section>

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            disabled={saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? "Saving…" : "Save configuration"}
          </button>
          {config.workspaces.map((workspace) => (
            <button
              className="rounded-md border px-4 py-2 disabled:opacity-50"
              disabled={saving}
              key={workspace.id}
              onClick={async () => {
                if (await save()) {
                  window.location.assign(`/?workspace=${encodeURIComponent(workspace.id)}`);
                }
              }}
              type="button"
            >
              Open {workspace.name || workspace.id}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
