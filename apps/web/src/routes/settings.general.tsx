import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  checkCoderDeploymentAuthentication,
  loginToCoderDeployment,
  type CoderDeploymentAuthenticationStatus,
  type CoderDeploymentProfile,
} from "../coder/api";
import { useCoder } from "../coder/CoderBootstrap";
import {
  CoderWorkspaceIssueList,
  summarizeCoderWorkspaceError,
  type CoderWorkspaceIssue,
} from "../components/CoderWorkspaceIssues";
import { PortForwardSettings } from "../components/settings/PortForwardSettings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { readLocalApi } from "../localApi";
import { randomUUID } from "../lib/utils";

type AuthStatus = "checking" | CoderDeploymentAuthenticationStatus;

function newDeploymentId(): string {
  return `coder-${randomUUID()}`;
}

function CoderSettingsView() {
  const {
    config,
    connectionErrors,
    connectWorkspace,
    disconnectWorkspace,
    refreshWorkspaceRuntime,
    restartWorkspace,
    saveConfig,
    startWorkspace,
    updateWorkspace,
    workspaceRuntime,
  } = useCoder();
  const [authByDeployment, setAuthByDeployment] = useState<Readonly<Record<string, AuthStatus>>>(
    {},
  );
  const [authenticating, setAuthenticating] = useState<string | null>(null);
  const [workspaceAction, setWorkspaceAction] = useState<{
    readonly id: string;
    readonly kind: "start" | "restart" | "update";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAuth = async (deploymentId: string): Promise<void> => {
    setAuthByDeployment((current) => ({ ...current, [deploymentId]: "checking" }));
    const status = await checkCoderDeploymentAuthentication(deploymentId);
    setAuthByDeployment((current) => ({
      ...current,
      [deploymentId]: status,
    }));
  };

  useEffect(() => {
    for (const deployment of config.deployments) {
      void refreshAuth(deployment.id).catch(() => {
        setAuthByDeployment((current) => ({ ...current, [deployment.id]: "unavailable" }));
      });
    }
  }, [config.deployments]);

  useEffect(() => {
    void refreshWorkspaceRuntime();
    const interval = window.setInterval(() => void refreshWorkspaceRuntime(), 5_000);
    return () => window.clearInterval(interval);
  }, [refreshWorkspaceRuntime]);

  const login = async (deploymentId: string): Promise<void> => {
    setAuthenticating(deploymentId);
    setError(null);
    try {
      await loginToCoderDeployment(deploymentId);
      await refreshAuth(deploymentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Coder login failed.");
    } finally {
      setAuthenticating(null);
    }
  };

  const runWorkspaceAction = async (
    workspaceId: string,
    workspaceName: string,
    kind: "start" | "restart" | "update",
  ): Promise<void> => {
    if (kind !== "start") {
      const localApi = readLocalApi();
      if (localApi === undefined) return;
      const label = kind === "restart" ? "Restart" : "Update";
      const confirmed = await localApi.dialogs.confirm(
        [
          `${label} ${workspaceName}?`,
          "All ongoing sessions in this workspace will be stopped.",
          `T3 Coder will reconnect after the ${kind} completes.`,
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }

    setWorkspaceAction({ id: workspaceId, kind });
    setError(null);
    try {
      if (kind === "start") await startWorkspace(workspaceId);
      else if (kind === "restart") await restartWorkspace(workspaceId);
      else await updateWorkspace(workspaceId);
      await refreshWorkspaceRuntime();
    } catch {
      // CoderBootstrap records the current workspace-scoped failure.
    } finally {
      setWorkspaceAction(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Coder connections</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Add each Coder domain once. Authentication happens in the terminal that is running T3
            Coder; project setup only asks you to choose a domain, workspace, and folder.
          </p>
        </header>

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}

        <section className="space-y-3">
          {config.deployments.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              No Coder domains have been added yet.
            </div>
          ) : null}
          {config.deployments.map((deployment) => (
            <DeploymentCard
              authStatus={authByDeployment[deployment.id] ?? "checking"}
              authenticationBusy={authenticating !== null}
              authenticating={authenticating === deployment.id}
              deployment={deployment}
              hasWorkspaces={config.workspaces.some(
                (workspace) => workspace.deploymentId === deployment.id,
              )}
              key={deployment.id}
              onLogin={() => void login(deployment.id)}
              onRefreshAuth={() => void refreshAuth(deployment.id)}
              onRemove={async () => {
                setError(null);
                try {
                  await saveConfig({
                    ...config,
                    deployments: config.deployments.filter((entry) => entry.id !== deployment.id),
                  });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not remove domain.");
                }
              }}
              onSave={async (next) => {
                setError(null);
                try {
                  await saveConfig({
                    ...config,
                    deployments: config.deployments.map((entry) =>
                      entry.id === deployment.id ? next : entry,
                    ),
                  });
                  await refreshAuth(deployment.id);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not save domain.");
                  throw cause;
                }
              }}
            />
          ))}
        </section>

        <AddDeploymentForm
          onAdd={async (deployment) => {
            setError(null);
            try {
              await saveConfig({
                ...config,
                deployments: [...config.deployments, deployment],
              });
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not add domain.");
              throw cause;
            }
          }}
        />

        <section className="space-y-3 border-t pt-7">
          <div>
            <h2 className="text-lg font-semibold">Workspace connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Workspaces are added automatically when you select a project folder.
            </p>
          </div>
          {config.workspaces.length === 0 ? (
            <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
              No workspaces are connected.
            </p>
          ) : (
            config.workspaces.map((workspace) => {
              const deployment = config.deployments.find(
                (entry) => entry.id === workspace.deploymentId,
              );
              const runtime = workspaceRuntime[workspace.id];
              const action = workspaceAction?.id === workspace.id ? workspaceAction.kind : null;
              const checking = runtime === undefined;
              const starting = runtime?.status === "starting" || action !== null;
              const statusUnavailable = runtime?.status === "unavailable";
              const workspaceIssues: CoderWorkspaceIssue[] = [];
              if (statusUnavailable && runtime.error !== undefined) {
                workspaceIssues.push({
                  id: "status",
                  title: "Workspace status unavailable",
                  summary: summarizeCoderWorkspaceError(runtime.error),
                  details: runtime.error,
                });
              }
              const connectionError = connectionErrors[workspace.id];
              if (
                connectionError !== undefined &&
                !checking &&
                !starting &&
                !statusUnavailable &&
                runtime.status !== "stopped"
              ) {
                workspaceIssues.push({
                  id: "connection",
                  title: "T3 connection failed",
                  summary: summarizeCoderWorkspaceError(connectionError),
                  details: connectionError,
                });
              }
              return (
                <div className="rounded-xl border bg-card p-4" key={workspace.id}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{workspace.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {deployment?.name ?? workspace.deploymentId} · {workspace.workspace}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge variant="outline">
                          {runtime === undefined
                            ? "Checking…"
                            : runtime.status === "running"
                              ? "Running"
                              : runtime.status === "starting"
                                ? "Starting"
                                : runtime.status === "stopped"
                                  ? "Stopped"
                                  : runtime.status === "unavailable"
                                    ? "Status unavailable"
                                    : "Unknown"}
                        </Badge>
                        {runtime?.updateAvailable ? (
                          <Badge variant="outline">Update available</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      {runtime?.status === "stopped" ? (
                        <Button
                          disabled={workspaceAction !== null}
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runWorkspaceAction(workspace.id, workspace.name, "start")
                          }
                        >
                          {action === "start" ? "Starting…" : "Start"}
                        </Button>
                      ) : (
                        <Button
                          disabled={checking || starting || statusUnavailable}
                          size="sm"
                          variant="outline"
                          onClick={() => void connectWorkspace(workspace.id).catch(() => undefined)}
                        >
                          {runtime?.status === "starting" ? "Starting…" : "Reconnect"}
                        </Button>
                      )}
                      {statusUnavailable ? (
                        <Button
                          disabled={workspaceAction !== null}
                          size="sm"
                          variant="outline"
                          onClick={() => void refreshWorkspaceRuntime()}
                        >
                          Retry status
                        </Button>
                      ) : null}
                      {runtime?.updateAvailable ? (
                        <Button
                          disabled={workspaceAction !== null || runtime.status === "starting"}
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runWorkspaceAction(workspace.id, workspace.name, "update")
                          }
                        >
                          {action === "update" ? "Updating…" : "Update"}
                        </Button>
                      ) : null}
                      {runtime?.status === "stopped" ? null : (
                        <Button
                          disabled={
                            workspaceAction !== null ||
                            checking ||
                            runtime?.status === "starting" ||
                            statusUnavailable
                          }
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runWorkspaceAction(workspace.id, workspace.name, "restart")
                          }
                        >
                          {action === "restart" ? "Restarting…" : "Restart"}
                        </Button>
                      )}
                      <Button
                        disabled={action !== null}
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          setError(null);
                          try {
                            await disconnectWorkspace(workspace.id);
                            await saveConfig({
                              ...config,
                              workspaces: config.workspaces.filter(
                                (entry) => entry.id !== workspace.id,
                              ),
                              ...(config.portForwards === undefined
                                ? {}
                                : {
                                    portForwards: config.portForwards.filter(
                                      (entry) => entry.workspaceId !== workspace.id,
                                    ),
                                  }),
                            });
                          } catch (cause) {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "Could not remove workspace.",
                            );
                          }
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <CoderWorkspaceIssueList issues={workspaceIssues} />
                </div>
              );
            })
          )}
        </section>

        <PortForwardSettings
          config={config}
          workspaceRuntime={workspaceRuntime}
          onError={setError}
          onSaveConfig={saveConfig}
        />

        <aside className="rounded-xl border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
          Coder 2.25.3 stores each session token in a plaintext Coder config file. T3 Coder gives
          each domain a separate profile directory so multiple domains remain signed in, but it
          never reads, copies, logs, or displays those token files.
        </aside>
      </div>
    </div>
  );
}

function DeploymentCard({
  authStatus,
  authenticationBusy,
  authenticating,
  deployment,
  hasWorkspaces,
  onLogin,
  onRemove,
  onRefreshAuth,
  onSave,
}: {
  readonly authStatus: AuthStatus;
  readonly authenticationBusy: boolean;
  readonly authenticating: boolean;
  readonly deployment: CoderDeploymentProfile;
  readonly hasWorkspaces: boolean;
  readonly onLogin: () => void;
  readonly onRemove: () => Promise<void>;
  readonly onRefreshAuth: () => void;
  readonly onSave: (deployment: CoderDeploymentProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState(deployment);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(deployment), [deployment]);

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{deployment.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{deployment.url}</p>
        </div>
        <AuthBadge status={authStatus} />
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Display name">
          <Input value={draft.name} onValueChange={(name) => setDraft({ ...draft, name })} />
        </Field>
        <Field label="Coder domain">
          <Input
            inputMode="url"
            value={draft.url}
            onValueChange={(url) => setDraft({ ...draft, url })}
          />
        </Field>
        <Field className="sm:col-span-2" label="Coder executable (optional)">
          <Input
            placeholder="coder or C:\\path\\to\\coder.exe"
            value={draft.executable ?? ""}
            onValueChange={(executable) => {
              const { executable: _currentExecutable, ...withoutExecutable } = draft;
              setDraft(executable.trim() ? { ...draft, executable } : withoutExecutable);
            }}
          />
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={authenticationBusy || authStatus === "checking"}
          onClick={authStatus === "unavailable" ? onRefreshAuth : onLogin}
          variant={
            authStatus === "authenticated" || authStatus === "unavailable" ? "outline" : "default"
          }
        >
          {authenticating
            ? "Waiting for terminal…"
            : authStatus === "authenticated"
              ? "Reauthenticate"
              : authStatus === "unavailable"
                ? "Check again"
                : authStatus === "checking"
                  ? "Checking…"
                  : "Sign in"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft);
            } catch {
              // The settings page reports the validation or gateway error.
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={hasWorkspaces} onClick={() => void onRemove()}>
          Remove
        </Button>
        {authenticating ? (
          <p className="w-full pt-2 text-xs text-muted-foreground">
            In the terminal running T3 Coder, open the printed sign-in URL manually and paste the
            one-time Coder token at the hidden prompt.
          </p>
        ) : null}
        {hasWorkspaces ? (
          <p className="w-full pt-1 text-xs text-muted-foreground">
            Remove this domain’s workspace connections before removing the domain.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AuthBadge({ status }: { readonly status: AuthStatus }) {
  if (status === "checking") {
    return (
      <Badge variant="outline">
        <LoaderCircleIcon className="animate-spin" /> Checking
      </Badge>
    );
  }
  if (status === "authenticated") {
    return (
      <Badge variant="success">
        <CheckCircle2Icon /> Signed in
      </Badge>
    );
  }
  if (status === "unavailable") {
    return (
      <Badge variant="warning">
        <CircleAlertIcon /> Unavailable
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      <CircleAlertIcon /> Sign-in required
    </Badge>
  );
}

function AddDeploymentForm({
  onAdd,
}: {
  readonly onAdd: (deployment: CoderDeploymentProfile) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [executable, setExecutable] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onAdd({
        id: newDeploymentId(),
        name,
        url,
        ...(executable.trim() ? { executable } : {}),
      });
      setName("");
      setUrl("");
      setExecutable("");
    } catch {
      // The settings page reports the validation or gateway error.
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rounded-xl border border-dashed p-5" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-2">
        <PlusIcon className="size-4" />
        <h2 className="font-medium">Add Coder domain</h2>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Display name">
          <Input placeholder="Goldman Coder" required value={name} onValueChange={setName} />
        </Field>
        <Field label="Coder domain">
          <Input
            inputMode="url"
            placeholder="https://coder.example.gs.com"
            required
            value={url}
            onValueChange={setUrl}
          />
        </Field>
        <Field className="sm:col-span-2" label="Coder executable (optional)">
          <Input
            placeholder="coder or C:\\path\\to\\coder.exe"
            value={executable}
            onValueChange={setExecutable}
          />
        </Field>
      </div>
      <Button className="mt-5" size="sm" type="submit" disabled={saving}>
        {saving ? "Adding…" : "Add domain"}
      </Button>
    </form>
  );
}

function Field({
  children,
  className,
  label,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-2 text-xs">{label}</Label>
      {children}
    </div>
  );
}

export const Route = createFileRoute("/settings/general")({ component: CoderSettingsView });
