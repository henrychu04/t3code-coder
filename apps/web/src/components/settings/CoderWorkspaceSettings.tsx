import { useEnvironments } from "../../state/environments";
import { coderWorkspaceIdForEnvironment } from "../../coder/environmentStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MoreHorizontalIcon } from "lucide-react";
import { useCoder } from "../../coder/CoderBootstrap";
import { readLocalApi } from "../../localApi";
import {
  CoderWorkspaceIssueList,
  summarizeCoderWorkspaceError,
  type CoderWorkspaceIssue,
} from "../CoderWorkspaceIssues";
import { CoderWorkspaceDiagnostics } from "../CoderWorkspaceDiagnostics";
import { formatCoderAutostop } from "../CoderWorkspaceLatency";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsSection } from "./SettingsPage";
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
  const {
    config,
    connectionErrors,
    connectWorkspace,
    disconnectWorkspace,
    refreshWorkspaceRuntime,
    restartWorkspace,
    startWorkspace,
    stopWorkspace,
    updateWorkspace,
    workspaceRuntime,
  } = useCoder();
  const operation = useSettingsOperation();
  const poll = useSettingsPolling({
    identity: JSON.stringify(config.workspaces),
    intervalMs: 5_000,
    enabled: config.workspaces.length > 0,
    load: refreshWorkspaceRuntime,
  });
  const pendingAction = operation.pending
    ? (JSON.parse(operation.pending) as [string, string])
    : null;
  const failedWorkspaceId = operation.error
    ? (JSON.parse(operation.error.key) as [string, string])[0]
    : null;
  const runWorkspaceAction = (
    workspaceId: string,
    workspaceName: string,
    kind: "start" | "stop" | "restart" | "update",
  ) =>
    operation.run(JSON.stringify([workspaceId, kind]), `Could not ${kind} workspace`, async () => {
      if (kind !== "start") {
        const localApi = readLocalApi();
        if (localApi === undefined) return;
        const label = kind === "stop" ? "Stop" : kind === "restart" ? "Restart" : "Update";
        const confirmed = await localApi.dialogs.confirm(
          (kind === "stop"
            ? [
                `${label} ${workspaceName}?`,
                "All ongoing sessions in this workspace will be stopped.",
                "Saved port forwards will remain stopped until the workspace starts again.",
              ]
            : [
                `${label} ${workspaceName}?`,
                "All ongoing sessions in this workspace will be stopped.",
                `T3 Coder will reconnect after the ${kind} completes.`,
              ]
          ).join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }

      if (kind === "start") await startWorkspace(workspaceId);
      else if (kind === "stop") await stopWorkspace(workspaceId);
      else if (kind === "restart") await restartWorkspace(workspaceId);
      else await updateWorkspace(workspaceId);
      await poll.refresh();
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
          config.workspaces.map((workspace) => {
            const deployment = config.deployments.find(
              (entry) => entry.id === workspace.deploymentId,
            );
            const runtime = workspaceRuntime[workspace.id];
            const action = pendingAction?.[0] === workspace.id ? pendingAction[1] : null;
            const checking = runtime === undefined && poll.error === null;
            const starting = runtime?.status === "starting" || action !== null;
            const statusUnavailable = runtime?.status === "unavailable" || poll.error !== null;
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
            return (
              <SettingsResource
                key={workspace.id}
                title={
                  <span className="flex items-center gap-2">
                    <EnvironmentMachineIcon
                      className="size-4"
                      kind={
                        environments.find(
                          (environment) =>
                            coderWorkspaceIdForEnvironment(environment.environmentId) ===
                            workspace.id,
                        )?.serverConfig?.settings.environmentIcon ?? "server"
                      }
                    />
                    {workspace.name}
                  </span>
                }
                description={`${deployment?.name ?? workspace.deploymentId} · ${workspace.workspace}`}
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
                        ? ({
                            start: "Starting…",
                            stop: "Stopping…",
                            restart: "Restarting…",
                            update: "Updating…",
                            connect: "Connecting…",
                            remove: "Removing…",
                          }[action] ?? "Working…")
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
                    {runtime?.updateAvailable ? (
                      <Badge variant="outline">Update available</Badge>
                    ) : null}
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
                      disabled={
                        operation.pending !== null || checking || (starting && action === null)
                      }
                      onClick={() => {
                        if (statusUnavailable) void poll.refresh();
                        else if (runtime?.status === "stopped")
                          void runWorkspaceAction(workspace.id, workspace.name, "start");
                        else
                          void operation.run(
                            JSON.stringify([workspace.id, "connect"]),
                            "Could not reconnect workspace",
                            () => connectWorkspace(workspace.id),
                          );
                      }}
                    >
                      {action
                        ? ({
                            start: "Starting…",
                            stop: "Stopping…",
                            restart: "Restarting…",
                            update: "Updating…",
                            connect: "Connecting…",
                            remove: "Removing…",
                          }[action] ?? "Working…")
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
                            disabled={operation.pending !== null}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        }
                      />
                      <MenuPopup align="end">
                        {runtime?.updateAvailable ? (
                          <MenuItem
                            disabled={
                              checking || runtime.status === "starting" || statusUnavailable
                            }
                            onClick={() =>
                              void runWorkspaceAction(workspace.id, workspace.name, "update")
                            }
                          >
                            Update workspace
                          </MenuItem>
                        ) : null}
                        <MenuItem
                          disabled={
                            checking ||
                            starting ||
                            statusUnavailable ||
                            runtime?.status === "stopped"
                          }
                          onClick={() =>
                            void runWorkspaceAction(workspace.id, workspace.name, "restart")
                          }
                        >
                          Restart workspace
                        </MenuItem>
                        <MenuItem
                          disabled={
                            checking ||
                            starting ||
                            statusUnavailable ||
                            runtime?.status === "stopped"
                          }
                          onClick={() =>
                            void runWorkspaceAction(workspace.id, workspace.name, "stop")
                          }
                        >
                          Stop workspace
                        </MenuItem>
                        <MenuItem
                          onClick={() =>
                            void operation.run(
                              JSON.stringify([workspace.id, "remove"]),
                              "Could not remove workspace connection",
                              async () => {
                                await disconnectWorkspace(workspace.id);
                                await updateConfig((current) => ({
                                  ...current,
                                  workspaces: current.workspaces.filter(
                                    (entry) => entry.id !== workspace.id,
                                  ),
                                  ...(current.portForwards === undefined
                                    ? {}
                                    : {
                                        portForwards: current.portForwards.filter(
                                          (entry) => entry.workspaceId !== workspace.id,
                                        ),
                                      }),
                                }));
                              },
                            )
                          }
                        >
                          Remove connection
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </>
                }
              >
                <CoderWorkspaceIssueList issues={workspaceIssues} />
                <SettingsResourceError
                  error={
                    operation.error && failedWorkspaceId === workspace.id
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
          })
        )}
      </>
    </SettingsSection>
  );
}
