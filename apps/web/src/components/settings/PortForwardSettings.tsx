import {
  CircleAlertIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  loadCoderPortForwardStatuses,
  restartCoderPortForward,
  type CoderPortForwardProfile,
  type CoderPortForwardRuntimeStatus,
  type CoderProfileConfig,
  type CoderWorkspaceProfile,
  type CoderWorkspaceRuntimeStatus,
} from "../../coder/api";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsSection, SettingsSelect } from "./SettingsPage";
import {
  SettingsResource,
  SettingsResourceDialog,
  SettingsResourceEmpty,
  SettingsResourceError,
  SettingsField,
} from "./SettingsResource";
import { useSettingsPolling } from "./useSettingsPolling";
import { useSettingsOperation } from "./useSettingsOperation";
import type { UpdateCoderSettingsConfig } from "./useCoderSettingsConfig";
const EMPTY_PORT_FORWARDS: readonly CoderPortForwardProfile[] = [];

export function formatCoderPortForwardCommand(
  rule: Pick<CoderPortForwardProfile, "localPort" | "protocol" | "remotePort">,
  workspace: Pick<CoderWorkspaceProfile, "workspace">,
): string {
  return `coder port-forward ${workspace.workspace} --${rule.protocol} 127.0.0.1:${rule.localPort}:${rule.remotePort}`;
}

function port(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

export function PortForwardSettings({
  config,
  workspaceRuntime,
  updateConfig,
}: {
  config: CoderProfileConfig;
  workspaceRuntime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>;
  updateConfig: UpdateCoderSettingsConfig;
}) {
  const rules = config.portForwards ?? EMPTY_PORT_FORWARDS;
  const [editing, setEditing] = useState<CoderPortForwardProfile | "new" | null>(null);
  const operation = useSettingsOperation();
  const query = useSettingsPolling({
    load: loadCoderPortForwardStatuses,
    identity: JSON.stringify(rules),
    intervalMs: 2_000,
    enabled: rules.length > 0,
  });
  const statuses = new Map(query.data?.map((status) => [status.id, status]));
  return (
    <>
      <SettingsSection
        id="port-forwarding"
        title="Port forwarding"
        description="Access workspace ports at 127.0.0.1 on this computer."
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={config.workspaces.length === 0 || operation.pending !== null}
            onClick={() => setEditing("new")}
          >
            <PlusIcon />
            Add forward
          </Button>
        }
      >
        {rules.length === 0 ? (
          <SettingsResourceEmpty>
            {config.workspaces.length
              ? "No ports are forwarded yet."
              : "Connect a workspace before adding a port forward."}
          </SettingsResourceEmpty>
        ) : (
          rules.map((rule) => {
            const workspace = config.workspaces.find((entry) => entry.id === rule.workspaceId);
            if (!workspace) return null;
            const status = statuses.get(rule.id);
            const runtime = workspaceRuntime[workspace.id];
            const unavailable = query.error !== null || runtime?.status === "unavailable";
            const blocked =
              runtime === undefined ||
              runtime.status === "stopped" ||
              runtime.status === "starting" ||
              unavailable ||
              status === undefined;
            const error =
              operation.error?.key === rule.id
                ? operation.error
                : query.error
                  ? { title: "Could not check port-forward status", details: query.error }
                  : runtime?.status === "unavailable"
                    ? {
                        title: "Workspace status unavailable",
                        details: runtime.error ?? "Could not check the workspace.",
                      }
                    : status?.status === "error"
                      ? {
                          title: "Port forward failed",
                          details: status.error ?? "The forward could not be started.",
                        }
                      : null;
            return (
              <SettingsResource
                key={rule.id}
                title={`${workspace.name} · ${rule.protocol.toUpperCase()}`}
                description={`127.0.0.1:${rule.localPort} → ${workspace.workspace}:${rule.remotePort}`}
                status={
                  <PortForwardStatusBadge
                    status={runtime === undefined ? undefined : status}
                    unavailable={unavailable}
                  />
                }
                actions={
                  <>
                    <Button
                      aria-label={
                        query.error ? "Retry port-forward status" : "Restart port forward"
                      }
                      size="xs"
                      variant="outline"
                      disabled={
                        operation.pending !== null || (query.error ? query.pending : blocked)
                      }
                      onClick={() => {
                        if (query.error) void query.refresh();
                        else
                          void operation.run(
                            rule.id,
                            "Could not restart port forward",
                            async () => {
                              await restartCoderPortForward(rule.id);
                              await query.refresh();
                            },
                          );
                      }}
                    >
                      <RotateCwIcon />
                      {operation.pending === rule.id
                        ? "Working…"
                        : query.error
                          ? "Retry status"
                          : "Restart"}
                    </Button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Actions for local ${rule.protocol.toUpperCase()} port ${rule.localPort}`}
                            disabled={operation.pending !== null}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        }
                      />
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing(rule)}>Edit forward</MenuItem>
                        <MenuItem
                          onClick={() =>
                            void operation.run(rule.id, "Could not remove port forward", () =>
                              updateConfig((current) => ({
                                ...current,
                                portForwards: (current.portForwards ?? []).filter(
                                  (entry) => entry.id !== rule.id,
                                ),
                              })),
                            )
                          }
                        >
                          Remove forward
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </>
                }
              >
                <SettingsResourceError error={error} />
              </SettingsResource>
            );
          })
        )}
      </SettingsSection>
      {editing !== null ? (
        <PortForwardEditor
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          existingRules={rules}
          workspaces={config.workspaces}
          updateConfig={updateConfig}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

export function PortForwardStatusBadge({
  status,
  unavailable,
}: {
  readonly status: CoderPortForwardRuntimeStatus | undefined;
  readonly unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <Badge variant="warning">
        <CircleAlertIcon /> Status unavailable
      </Badge>
    );
  }
  if (status?.status === "running") return <Badge variant="success">Running</Badge>;
  if (status?.status === "stopped") return <Badge variant="outline">Stopped</Badge>;
  if (status?.status === "error") {
    return (
      <Badge variant="error">
        <CircleAlertIcon /> Error
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <LoaderCircleIcon className="animate-spin" />
      {status === undefined ? "Checking…" : "Starting"}
    </Badge>
  );
}

export function PortForwardEditor({
  rule,
  existingRules,
  workspaces,
  updateConfig,
  onClose,
}: {
  rule: CoderPortForwardProfile | null;
  existingRules: readonly CoderPortForwardProfile[];
  workspaces: readonly CoderWorkspaceProfile[];
  updateConfig: UpdateCoderSettingsConfig;
  onClose: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(rule?.workspaceId ?? workspaces[0]?.id ?? "");
  const [protocol, setProtocol] = useState<"tcp" | "udp">(rule?.protocol ?? "tcp");
  const [localPort, setLocalPort] = useState(String(rule?.localPort ?? 3000));
  const [remotePort, setRemotePort] = useState(String(rule?.remotePort ?? 3000));
  const operation = useSettingsOperation();
  const workspaceFieldId = useId();
  const protocolFieldId = useId();
  const localPortFieldId = useId();
  const remotePortFieldId = useId();
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const parsedLocalPort = port(localPort);
  const parsedRemotePort = port(remotePort);
  const duplicateLocalPort = existingRules.some(
    (candidate) =>
      candidate.protocol === protocol &&
      candidate.localPort === parsedLocalPort &&
      candidate.id !== rule?.id,
  );
  const command = useMemo(
    () =>
      selectedWorkspace && parsedLocalPort && parsedRemotePort
        ? formatCoderPortForwardCommand(
            { protocol, localPort: parsedLocalPort, remotePort: parsedRemotePort },
            selectedWorkspace,
          )
        : null,
    [parsedLocalPort, parsedRemotePort, protocol, selectedWorkspace],
  );

  return (
    <SettingsResourceDialog
      title={rule ? "Edit port forward" : "Add port forward"}
      description="Connect a port on this computer to a workspace. Saved forwards start automatically with T3 Coder."
      pending={operation.pending !== null}
      error={operation.error}
      onClose={onClose}
      submitLabel={rule ? "Save changes" : "Add and start"}
      submitDisabled={
        selectedWorkspace === undefined ||
        parsedLocalPort === null ||
        parsedRemotePort === null ||
        duplicateLocalPort
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !selectedWorkspace ||
          parsedLocalPort === null ||
          parsedRemotePort === null ||
          duplicateLocalPort
        )
          return;
        void operation
          .run("save", "Could not save port forward", () =>
            updateConfig((current) => {
              const next: CoderPortForwardProfile = {
                id: rule?.id ?? `port-forward-${randomUUID()}`,
                workspaceId: selectedWorkspace.id,
                protocol,
                localPort: parsedLocalPort,
                remotePort: parsedRemotePort,
              };
              const rules = current.portForwards ?? [];
              if (!current.workspaces.some((workspace) => workspace.id === next.workspaceId))
                throw new Error("The selected workspace connection was removed.");
              if (rule && !rules.some((entry) => entry.id === rule.id))
                throw new Error(
                  "This port forward was removed. Close the editor and add it again.",
                );
              if (
                rules.some(
                  (entry) =>
                    entry.id !== next.id &&
                    entry.protocol === next.protocol &&
                    entry.localPort === next.localPort,
                )
              )
                throw new Error("This local port is already configured for that protocol.");
              return {
                ...current,
                portForwards: rule
                  ? rules.map((entry) => (entry.id === rule.id ? next : entry))
                  : [...rules, next],
              };
            }),
          )
          .then((saved) => {
            if (saved) onClose();
          });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id={workspaceFieldId} label="Workspace">
          <SettingsSelect
            ariaLabel="Workspace"
            className="w-full min-w-0"
            disabled={workspaces.length === 0}
            id={workspaceFieldId}
            onChange={setWorkspaceId}
            value={workspaceId}
          >
            {workspaces.length === 0 ? <option value="">No workspaces configured</option> : null}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.workspace}
              </option>
            ))}
          </SettingsSelect>
        </SettingsField>
        <SettingsField id={protocolFieldId} label="Protocol">
          <SettingsSelect
            ariaLabel="Protocol"
            className="w-full min-w-0"
            id={protocolFieldId}
            onChange={(value) => setProtocol(value as "tcp" | "udp")}
            value={protocol}
          >
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </SettingsSelect>
        </SettingsField>
        <SettingsField id={localPortFieldId} label="Local port">
          <Input
            aria-invalid={localPort.length > 0 && (parsedLocalPort === null || duplicateLocalPort)}
            inputMode="numeric"
            id={localPortFieldId}
            max={65_535}
            min={1}
            nativeInput
            onChange={(event) => setLocalPort(event.currentTarget.value)}
            required
            type="number"
            value={localPort}
          />
          {duplicateLocalPort ? (
            <p className="mt-1.5 text-xs text-destructive-foreground">
              This local {protocol.toUpperCase()} port is already configured.
            </p>
          ) : null}
        </SettingsField>
        <SettingsField id={remotePortFieldId} label="Workspace port">
          <Input
            aria-invalid={remotePort.length > 0 && parsedRemotePort === null}
            inputMode="numeric"
            id={remotePortFieldId}
            max={65_535}
            min={1}
            nativeInput
            onChange={(event) => setRemotePort(event.currentTarget.value)}
            required
            type="number"
            value={remotePort}
          />
        </SettingsField>
      </div>
      {command ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Command details</summary>
          <code className="mt-2 block overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3">
            {command}
          </code>
        </details>
      ) : null}
    </SettingsResourceDialog>
  );
}
