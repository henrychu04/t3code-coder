import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { coderWorkspaceIdForEnvironment } from "../../coder/environmentStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MoreHorizontalIcon } from "lucide-react";
import { useCoder } from "../../coder/CoderBootstrap";
import { readLocalApi } from "../../localApi";
import type {
  CoderDeploymentProfile,
  CoderWorkspaceProfile,
  CoderWorkspaceRuntimeStatus,
} from "../../coder/api";
import { cn } from "../../lib/utils";
import {
  CoderWorkspaceIssueList,
  summarizeCoderWorkspaceError,
  type CoderWorkspaceIssue,
} from "../CoderWorkspaceIssues";
import { CoderWorkspaceDiagnostics } from "../CoderWorkspaceDiagnostics";
import { formatCoderAutostop } from "../CoderWorkspaceLatency";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { SettingsSection } from "./settingsLayout";
import { SettingsResource, SettingsResourceEmpty, SettingsResourceError } from "./SettingsResource";
import { useSettingsOperation } from "./useSettingsOperation";
import { useSettingsPolling } from "./useSettingsPolling";
import type { UpdateCoderSettingsConfig } from "./useCoderSettingsConfig";

export function CoderWorkspaceSettings({
  updateConfig,
}: {
  updateConfig: UpdateCoderSettingsConfig;
}) {
  const { environments } = useEnvironments();
  const { config, refreshWorkspaceRuntime, workspaceRuntime } = useCoder();
  const poll = useSettingsPolling({
    identity: JSON.stringify(config.workspaces),
    // Read status when the panel opens and after actions. Ongoing updates come from the
    // bootstrap's shared refresh (once a minute, faster while a workspace is changing).
    intervalMs: null,
    enabled: config.workspaces.length > 0,
    load: refreshWorkspaceRuntime,
  });

  return (
    <SettingsSection
      id="coder-workspaces"
      title="Workspace connections"
      description="Workspaces are added automatically when you select a project folder."
    >
      <>
        {config.workspaces.length === 0 ? (
          <SettingsResourceEmpty>
            No workspace connections yet. Choose a project folder to add one.
          </SettingsResourceEmpty>
        ) : (
          config.workspaces.map((workspace) => (
            <CoderWorkspaceRow
              key={workspace.id}
              workspace={workspace}
              deployment={config.deployments.find((entry) => entry.id === workspace.deploymentId)}
              environment={environments.find(
                (entry) => coderWorkspaceIdForEnvironment(entry.environmentId) === workspace.id,
              )}
              runtime={workspaceRuntime[workspace.id]}
              portForwardCount={
                (config.portForwards ?? []).filter((entry) => entry.workspaceId === workspace.id)
                  .length
              }
              poll={poll}
              updateConfig={updateConfig}
            />
          ))
        )}
      </>
    </SettingsSection>
  );
}

/**
 * Upstream's `savedBackendStatus` (ConnectionsSettings.tsx) without its switched-off state, which
 * Coder workspaces do not have: the row's T3 connection state, with the reason when failing.
 */
function workspaceConnectionStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
  update: "Updating…",
  connect: "Connecting…",
  remove: "Removing…",
};

/** One workspace connection. Each row runs its own actions, so a slow one blocks no other row. */
function CoderWorkspaceRow({
  workspace,
  deployment,
  environment,
  runtime,
  portForwardCount,
  poll,
  updateConfig,
}: {
  workspace: CoderWorkspaceProfile;
  deployment: CoderDeploymentProfile | undefined;
  environment: EnvironmentPresentation | undefined;
  runtime: CoderWorkspaceRuntimeStatus | undefined;
  portForwardCount: number;
  poll: { error: string | null; pending: boolean; refresh: () => Promise<void> };
  updateConfig: UpdateCoderSettingsConfig;
}) {
  const {
    connectionErrors,
    connectWorkspace,
    disconnectWorkspace,
    restartWorkspace,
    startWorkspace,
    stopWorkspace,
    updateWorkspace,
  } = useCoder();
  const operation = useSettingsOperation();
  const action = operation.pending;
  const checking = runtime === undefined && poll.error === null;
  const starting = runtime?.status === "starting" || action !== null;
  const statusUnavailable = runtime?.status === "unavailable" || poll.error !== null;
  const connectionStatus = environment ? workspaceConnectionStatus(environment) : null;
  const workspaceIssues: CoderWorkspaceIssue[] = [];
  if (runtime?.status === "unavailable" && runtime.error !== undefined) {
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
    runtime?.status !== "stopped"
  ) {
    workspaceIssues.push({
      id: "connection",
      title: "T3 connection failed",
      summary: summarizeCoderWorkspaceError(connectionError),
      details: connectionError,
    });
  }

  const confirm = async (lines: readonly string[]) => {
    const localApi = readLocalApi();
    if (localApi === undefined) return false;
    return localApi.dialogs.confirm(lines.join("\n"), { variant: "destructive" });
  };
  const runWorkspaceAction = (kind: "start" | "stop" | "restart" | "update") =>
    operation.run(kind, `Could not ${kind} workspace`, async () => {
      if (kind !== "start") {
        const label = kind === "stop" ? "Stop" : kind === "restart" ? "Restart" : "Update";
        const confirmed = await confirm(
          kind === "stop"
            ? [
                `${label} ${workspace.name}?`,
                "All ongoing sessions in this workspace will be stopped.",
                "Saved port forwards will remain stopped until the workspace starts again.",
              ]
            : [
                `${label} ${workspace.name}?`,
                "All ongoing sessions in this workspace will be stopped.",
                `T3 Coder will reconnect after the ${kind} completes.`,
              ],
        );
        if (!confirmed) return;
      }

      if (kind === "start") await startWorkspace(workspace.id);
      else if (kind === "stop") await stopWorkspace(workspace.id);
      else if (kind === "restart") await restartWorkspace(workspace.id);
      else await updateWorkspace(workspace.id);
      await poll.refresh();
    });
  const removeConnection = () =>
    operation.run("remove", "Could not remove workspace connection", async () => {
      const confirmed = await confirm([
        `Remove ${workspace.name} from T3 Coder?`,
        "The workspace and its threads stay in Coder; this computer stops connecting to it.",
        ...(portForwardCount > 0
          ? [
              portForwardCount === 1
                ? "Its saved port forward will be removed."
                : `Its ${String(portForwardCount)} saved port forwards will be removed.`,
            ]
          : []),
      ]);
      if (!confirmed) return;
      await disconnectWorkspace(workspace.id);
      await updateConfig((current) => ({
        ...current,
        workspaces: current.workspaces.filter((entry) => entry.id !== workspace.id),
        ...(current.portForwards === undefined
          ? {}
          : {
              portForwards: current.portForwards.filter(
                (entry) => entry.workspaceId !== workspace.id,
              ),
            }),
      }));
    });

  return (
    <SettingsResource
      title={
        <span className="flex items-center gap-2">
          <EnvironmentMachineIcon
            className="size-4"
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
          />
          {workspace.name}
        </span>
      }
      description={
        <>
          {`${deployment?.name ?? workspace.deploymentId} · ${workspace.workspace}`}
          {connectionStatus ? (
            <>
              {" · "}
              <span className={cn(connectionStatus.tone === "error" && "text-destructive")}>
                {connectionStatus.text}
              </span>
            </>
          ) : null}
        </>
      }
      status={
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant={
              action
                ? "outline"
                : statusUnavailable || runtime?.status === "unknown"
                  ? "warning"
                  : runtime?.status === "running"
                    ? "success"
                    : "outline"
            }
          >
            {action
              ? (ACTION_LABELS[action] ?? "Working…")
              : statusUnavailable
                ? "Status unavailable"
                : runtime === undefined
                  ? "Checking…"
                  : runtime.status === "running"
                    ? "Running"
                    : runtime.status === "starting"
                      ? "Starting"
                      : runtime.status === "stopped"
                        ? "Stopped"
                        : "Unknown"}
          </Badge>
          {runtime?.updateAvailable ? <Badge variant="outline">Update available</Badge> : null}
          {runtime?.autostopAt ? (
            <Badge variant="outline">
              {formatCoderAutostop(
                runtime.autostopAt,
                Date.now(),
                runtime.requiredStopAt === runtime.autostopAt ? "required" : "idle",
              ) ?? "Stop scheduled"}
            </Badge>
          ) : null}
          {runtime?.requiredStopAt && runtime.requiredStopAt !== runtime.autostopAt ? (
            <Badge variant="outline">
              {formatCoderAutostop(runtime.requiredStopAt, Date.now(), "required") ??
                "Required stop scheduled"}
            </Badge>
          ) : null}
        </div>
      }
      actions={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={action !== null || checking || starting}
            onClick={() => {
              if (statusUnavailable) void poll.refresh();
              else if (runtime?.status === "stopped") void runWorkspaceAction("start");
              else
                void operation.run("connect", "Could not reconnect workspace", () =>
                  connectWorkspace(workspace.id),
                );
            }}
          >
            {action
              ? (ACTION_LABELS[action] ?? "Working…")
              : statusUnavailable
                ? "Retry status"
                : runtime?.status === "stopped"
                  ? "Start"
                  : "Reconnect"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${workspace.name}`}
                  disabled={action !== null}
                >
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              {environment ? (
                <>
                  <EnvironmentIconMenu
                    environmentId={environment.environmentId}
                    serverConfig={environment.serverConfig}
                  />
                  <MenuSeparator />
                </>
              ) : null}
              {runtime?.updateAvailable ? (
                <MenuItem
                  disabled={checking || runtime.status === "starting" || statusUnavailable}
                  onClick={() => void runWorkspaceAction("update")}
                >
                  Update workspace
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={
                  checking || starting || statusUnavailable || runtime?.status === "stopped"
                }
                onClick={() => void runWorkspaceAction("restart")}
              >
                Restart workspace
              </MenuItem>
              <MenuItem
                disabled={
                  checking || starting || statusUnavailable || runtime?.status === "stopped"
                }
                onClick={() => void runWorkspaceAction("stop")}
              >
                Stop workspace
              </MenuItem>
              <MenuItem onClick={() => void removeConnection()}>Remove connection</MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      <CoderWorkspaceIssueList issues={workspaceIssues} />
      <SettingsResourceError
        error={
          operation.error
            ? operation.error
            : poll.error
              ? { title: "Could not check workspace status", details: poll.error }
              : null
        }
        retry={poll.error ? () => void poll.refresh() : undefined}
        pending={poll.pending}
      />
      <CoderWorkspaceDiagnostics workspaceId={workspace.id} />
    </SettingsResource>
  );
}
