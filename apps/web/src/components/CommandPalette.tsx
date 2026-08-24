import { useAtomCommand } from "../state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  FolderIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  checkCoderDeploymentAuthentication,
  discoverCoderWorkspaces,
  startCoderWorkspace,
  type CoderDeploymentAuthenticationStatus,
  type DiscoveredCoderWorkspace,
} from "../coder/api";
import { useCoder } from "../coder/CoderBootstrap";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { newProjectId, randomUUID } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useEnvironment } from "../state/environments";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

export function CommandPalette({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      onOpenCommandPalette(() => {
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {children}
      {open ? <AddProjectDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddProjectDialog({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const { config, connectWorkspace, saveConfig } = useCoder();
  const [deploymentId, setDeploymentId] = useState(config.deployments[0]?.id ?? "");
  const [authByDeployment, setAuthByDeployment] = useState<
    Readonly<Record<string, CoderDeploymentAuthenticationStatus>>
  >({});
  const [workspaces, setWorkspaces] = useState<readonly DiscoveredCoderWorkspace[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [connectingTarget, setConnectingTarget] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const environment = useEnvironment(environmentId);
  const projects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create);
  const handleNewThread = useNewThreadHandler();

  useEffect(() => {
    let cancelled = false;
    for (const deployment of config.deployments) {
      void checkCoderDeploymentAuthentication(deployment.id)
        .then((status) => {
          if (!cancelled) {
            setAuthByDeployment((current) => ({
              ...current,
              [deployment.id]: status,
            }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAuthByDeployment((current) => ({
              ...current,
              [deployment.id]: "unavailable",
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [config.deployments]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const selectedDeployment = config.deployments.find((entry) => entry.id === deploymentId) ?? null;
  const authenticationStatus = authByDeployment[deploymentId];
  const authenticated = authenticationStatus === "authenticated";

  const discover = async (): Promise<void> => {
    if (!selectedDeployment) return;
    setDiscovering(true);
    setError(null);
    try {
      setWorkspaces(await discoverCoderWorkspaces(selectedDeployment.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discover workspaces.");
    } finally {
      setDiscovering(false);
    }
  };

  const chooseWorkspace = async (workspace: DiscoveredCoderWorkspace): Promise<void> => {
    if (!selectedDeployment) return;
    setConnectingTarget(workspace.target);
    setError(null);
    try {
      const existing = config.workspaces.find(
        (entry) =>
          entry.deploymentId === selectedDeployment.id && entry.workspace === workspace.target,
      );
      const profile =
        existing ??
        ({
          id: `workspace-${randomUUID()}`,
          name: workspace.name,
          deploymentId: selectedDeployment.id,
          workspace: workspace.target,
        } as const);
      if (!existing) {
        await saveConfig({ ...config, workspaces: [...config.workspaces, profile] });
      }
      if (workspace.status === "stopped") await startCoderWorkspace(profile.id);
      const descriptor = await connectWorkspace(profile.id);
      setEnvironmentId(descriptor.environmentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to workspace.");
    } finally {
      setConnectingTarget(null);
    }
  };

  const addProject = async (cwd: string): Promise<void> => {
    if (environmentId === null) return;
    setError(null);
    try {
      const existing = projects.find(
        (project) => project.environmentId === environmentId && project.workspaceRoot === cwd,
      );
      const projectId = existing?.id ?? newProjectId();
      if (!existing) {
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(cwd),
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: resolveDefaultProviderModelSelection(
              environment?.serverConfig?.providers ?? [],
              null,
            ),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      await handleNewThread(scopeProjectRef(environmentId, projectId));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add project.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[10vh]"
      data-command-palette
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="w-full max-w-xl rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl">
        <div>
          <h2 className="text-base font-semibold">Add project</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a folder inside an authenticated Coder workspace. No files are copied.
          </p>
        </div>

        {environmentId === null ? (
          <div className="mt-5 space-y-5">
            {config.deployments.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                Add and sign in to a Coder domain in Settings first.
              </div>
            ) : (
              <>
                <div>
                  <Label className="mb-2 text-xs">Coder domain</Label>
                  <div className="relative">
                    <select
                      className="h-9 w-full appearance-none rounded-lg border border-input bg-background px-3 pe-9 text-sm"
                      value={deploymentId}
                      onChange={(event) => {
                        setDeploymentId(event.target.value);
                        setWorkspaces([]);
                        setError(null);
                      }}
                    >
                      {config.deployments.map((deployment) => (
                        <option key={deployment.id} value={deployment.id}>
                          {deployment.name} · {deployment.url}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute end-3 top-1/2 size-3 -translate-y-1/2 text-icon-muted opacity-50"
                    />
                  </div>
                  {authenticationStatus === "unauthenticated" ? (
                    <p className="mt-2 text-xs text-warning-foreground">
                      This domain needs sign-in. Authentication is managed in Settings.
                    </p>
                  ) : null}
                  {authenticationStatus === "unavailable" ? (
                    <p className="mt-2 text-xs text-warning-foreground">
                      Could not verify this Coder domain. Check its connection in Settings.
                    </p>
                  ) : null}
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Label className="text-xs">Workspace</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!authenticated || discovering}
                      onClick={() => void discover()}
                    >
                      {discovering
                        ? "Loading…"
                        : workspaces.length > 0
                          ? "Refresh"
                          : "Load workspaces"}
                    </Button>
                  </div>
                  {workspaces.length > 0 ? (
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                      {workspaces.map((workspace) => (
                        <button
                          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                          disabled={connectingTarget !== null || workspace.status === "starting"}
                          key={workspace.target}
                          onClick={() => void chooseWorkspace(workspace)}
                          type="button"
                        >
                          {connectingTarget === workspace.target ? (
                            <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
                          ) : (
                            <FolderOpenIcon className="size-4 shrink-0" />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{workspace.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {connectingTarget === workspace.target
                                ? "Preparing workspace… The first connection can take a few minutes."
                                : `${workspace.target} · ${
                                    workspace.status === "running"
                                      ? "Running"
                                      : workspace.status === "starting"
                                        ? "Starting"
                                        : workspace.status === "stopped"
                                          ? "Stopped"
                                          : "Unknown"
                                  }${workspace.updateAvailable ? " · Update available" : ""}`}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      {authenticated
                        ? "Load the workspaces available on this domain."
                        : authenticationStatus === "unauthenticated"
                          ? "Sign in to this domain from Settings before adding a project."
                          : "Verify this Coder domain in Settings before adding a project."}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <RemoteDirectoryBrowser environmentId={environmentId} onSelect={addProject} />
        )}

        {error ? <p className="mt-3 text-sm text-destructive-foreground">{error}</p> : null}
        <div className="mt-5 flex justify-between gap-2">
          <div>
            {environmentId !== null ? (
              <Button size="sm" variant="ghost" onClick={() => setEnvironmentId(null)}>
                <ChevronLeftIcon className="size-4" /> Choose another workspace
              </Button>
            ) : config.deployments.length === 0 || !authenticated ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onClose();
                  void navigate({ to: "/settings/general" });
                }}
              >
                <SettingsIcon className="size-4" /> Open Settings
              </Button>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </section>
    </div>
  );
}

function RemoteDirectoryBrowser({
  environmentId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSelect: (path: string) => Promise<void>;
}) {
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const query = useEnvironmentQuery(
    projectEnvironment.listDirectories({
      environmentId,
      input: requestedPath === null ? {} : { path: requestedPath },
    }),
  );
  const result = query.data;
  const currentPath = result?.path ?? requestedPath;
  const directories = useMemo(() => result?.directories ?? [], [result]);

  return (
    <div className="mt-5">
      <Label className="text-xs">Project folder</Label>
      <div className="mt-2 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <Button
            aria-label="Go to parent folder"
            size="sm"
            variant="ghost"
            disabled={!result?.parentPath || query.isPending}
            onClick={() => result?.parentPath && setRequestedPath(result.parentPath)}
          >
            <ChevronLeftIcon className="size-4" /> Up
          </Button>
          <p className="min-w-0 flex-1 truncate font-mono text-xs" title={currentPath ?? undefined}>
            {currentPath ?? "Workspace home"}
          </p>
        </div>
        <div className="max-h-72 min-h-40 overflow-y-auto p-1.5">
          {query.isPending && result === null ? (
            <div className="grid min-h-36 place-items-center text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-5 animate-spin" />
            </div>
          ) : query.error ? (
            <div className="p-4 text-sm text-destructive-foreground">{query.error}</div>
          ) : directories.length === 0 ? (
            <div className="grid min-h-36 place-items-center text-sm text-muted-foreground">
              No subfolders
            </div>
          ) : (
            directories.map((directory) => (
              <button
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                key={directory.path}
                onClick={() => setRequestedPath(directory.path)}
                type="button"
              >
                <FolderIcon className="size-4 shrink-0" />
                <span className="truncate">{directory.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
      {result?.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the first 500 subfolders are shown.
        </p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button
          size="sm"
          disabled={!currentPath || query.isPending || submitting}
          onClick={async () => {
            if (!currentPath) return;
            setSubmitting(true);
            try {
              await onSelect(currentPath);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? "Adding…" : "Use this folder"}
        </Button>
      </div>
    </div>
  );
}
