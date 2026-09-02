import {
  ArrowRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  NetworkIcon,
  PlusIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

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
import { Label } from "../ui/label";
import { SettingsSection } from "./SettingsPage";

type StatusById = Readonly<Record<string, CoderPortForwardRuntimeStatus>>;
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
  onSaveConfig,
  onError,
}: {
  readonly config: CoderProfileConfig;
  readonly workspaceRuntime: Readonly<Record<string, CoderWorkspaceRuntimeStatus>>;
  readonly onSaveConfig: (config: CoderProfileConfig) => Promise<unknown>;
  readonly onError: (message: string) => void;
}) {
  const rules = config.portForwards ?? EMPTY_PORT_FORWARDS;
  const [statuses, setStatuses] = useState<StatusById>({});
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatuses = async (): Promise<void> => {
    if (rules.length === 0) {
      setStatuses({});
      setStatusError(null);
      return;
    }
    try {
      const next = await loadCoderPortForwardStatuses();
      setStatuses(Object.fromEntries(next.map((status) => [status.id, status])));
      setStatusError(null);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setStatusError(
        `Could not fetch port-forward status.${detail.length === 0 ? "" : ` ${detail}`}`,
      );
      throw cause;
    }
  };

  useEffect(() => {
    if (rules.length === 0) {
      setStatuses({});
      setStatusError(null);
      return;
    }
    void refreshStatuses().catch(() => undefined);
    const interval = window.setInterval(() => void refreshStatuses().catch(() => undefined), 2_000);
    return () => window.clearInterval(interval);
  }, [rules]);

  return (
    <SettingsSection
      title="Port forwarding"
      description="Saved forwards start automatically with T3 Coder and bind only to 127.0.0.1 on this computer."
      unframed
    >
      <div className="space-y-4">
        {rules.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            <NetworkIcon className="size-4 shrink-0" />
            No ports are forwarded yet.
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => {
              const workspace = config.workspaces.find((entry) => entry.id === rule.workspaceId);
              if (workspace === undefined) return null;
              const status = statuses[rule.id];
              const workspaceStatus = workspaceRuntime[workspace.id];
              const workspaceStatusUnavailable = workspaceStatus?.status === "unavailable";
              const workspaceInactive =
                workspaceStatus?.status === "stopped" || workspaceStatus?.status === "starting";
              const checkingWorkspaceStatus = workspaceStatus === undefined;
              const displayError =
                (workspaceStatusUnavailable ? workspaceStatus.error : undefined) ??
                statusError ??
                (status?.status === "error" ? status.error : undefined);
              return (
                <div className="rounded-xl border bg-card p-4" key={rule.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{workspace.name}</p>
                        <PortForwardStatusBadge
                          status={checkingWorkspaceStatus ? undefined : status}
                          unavailable={statusError !== null || workspaceStatusUnavailable}
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="uppercase">{rule.protocol}</span>
                        <span>127.0.0.1:{rule.localPort}</span>
                        <ArrowRightIcon className="size-3" />
                        <span>
                          {workspace.workspace}:{rule.remotePort}
                        </span>
                      </div>
                      {displayError ? (
                        <p className="mt-2 text-xs text-destructive-foreground">{displayError}</p>
                      ) : null}
                    </div>
                    <Button
                      aria-label="Restart port forward"
                      disabled={
                        status === undefined ||
                        statusError !== null ||
                        checkingWorkspaceStatus ||
                        workspaceInactive ||
                        workspaceStatusUnavailable
                      }
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await restartCoderPortForward(rule.id);
                          await refreshStatuses();
                        } catch (cause) {
                          onError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not restart port forward.",
                          );
                        }
                      }}
                    >
                      <RotateCwIcon /> Restart
                    </Button>
                    <Button
                      aria-label="Remove port forward"
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await onSaveConfig({
                            ...config,
                            portForwards: rules.filter((entry) => entry.id !== rule.id),
                          });
                        } catch (cause) {
                          onError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not remove port forward.",
                          );
                        }
                      }}
                    >
                      <Trash2Icon /> Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <AddPortForwardForm
          existingRules={rules}
          workspaces={config.workspaces}
          onAdd={async (rule) => {
            try {
              await onSaveConfig({ ...config, portForwards: [...rules, rule] });
            } catch (cause) {
              const message =
                cause instanceof Error ? cause.message : "Could not add port forward.";
              onError(message);
              throw cause;
            }
          }}
        />
      </div>
    </SettingsSection>
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
      <Badge variant="error">
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

function AddPortForwardForm({
  existingRules,
  onAdd,
  workspaces,
}: {
  readonly existingRules: readonly CoderPortForwardProfile[];
  readonly onAdd: (rule: CoderPortForwardProfile) => Promise<void>;
  readonly workspaces: readonly CoderWorkspaceProfile[];
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
  const [localPort, setLocalPort] = useState("3000");
  const [remotePort, setRemotePort] = useState("3000");
  const [saving, setSaving] = useState(false);
  const workspaceFieldId = useId();
  const protocolFieldId = useId();
  const localPortFieldId = useId();
  const remotePortFieldId = useId();
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const parsedLocalPort = port(localPort);
  const parsedRemotePort = port(remotePort);
  const duplicateLocalPort = existingRules.some(
    (rule) => rule.protocol === protocol && rule.localPort === parsedLocalPort,
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

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (
      selectedWorkspace === undefined ||
      parsedLocalPort === null ||
      parsedRemotePort === null ||
      duplicateLocalPort
    ) {
      return;
    }
    setSaving(true);
    try {
      await onAdd({
        id: `port-forward-${randomUUID()}`,
        workspaceId: selectedWorkspace.id,
        protocol,
        localPort: parsedLocalPort,
        remotePort: parsedRemotePort,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rounded-xl border border-dashed p-5" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-2">
        <PlusIcon className="size-4" />
        <h3 className="font-medium">Add port forward</h3>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field htmlFor={workspaceFieldId} label="Workspace">
          <select
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64"
            disabled={workspaces.length === 0}
            id={workspaceFieldId}
            onChange={(event) => setWorkspaceId(event.currentTarget.value)}
            value={workspaceId}
          >
            {workspaces.length === 0 ? <option value="">No workspaces configured</option> : null}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.workspace}
              </option>
            ))}
          </select>
        </Field>
        <Field htmlFor={protocolFieldId} label="Protocol">
          <select
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id={protocolFieldId}
            onChange={(event) => setProtocol(event.currentTarget.value as "tcp" | "udp")}
            value={protocol}
          >
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </Field>
        <Field htmlFor={localPortFieldId} label="Local port">
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
        </Field>
        <Field htmlFor={remotePortFieldId} label="Workspace port">
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
        </Field>
      </div>
      {command ? (
        <div className="mt-4 rounded-lg bg-muted/60 px-3 py-2.5">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Command preview
          </p>
          <code className="block overflow-x-auto text-xs text-foreground">{command}</code>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={
            saving ||
            selectedWorkspace === undefined ||
            parsedLocalPort === null ||
            parsedRemotePort === null ||
            duplicateLocalPort
          }
          size="sm"
          type="submit"
        >
          {saving ? "Adding…" : "Add and auto-start"}
        </Button>
        <p className="text-xs text-muted-foreground">Available while T3 Coder is running.</p>
      </div>
    </form>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  readonly children: ReactNode;
  readonly htmlFor: string;
  readonly label: string;
}) {
  return (
    <div>
      <Label className="mb-2 text-xs" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  );
}
