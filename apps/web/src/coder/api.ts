import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

export interface CoderDeploymentProfile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly executable?: string;
}

export interface CoderWorkspaceProfile {
  readonly id: string;
  readonly name: string;
  readonly deploymentId: string;
  readonly workspace: string;
}

export interface CoderPortForwardProfile {
  readonly id: string;
  readonly workspaceId: string;
  readonly protocol: "tcp" | "udp";
  readonly localPort: number;
  readonly remotePort: number;
}

export interface CoderProfileConfig {
  readonly version: 1;
  readonly deployments: readonly CoderDeploymentProfile[];
  readonly workspaces: readonly CoderWorkspaceProfile[];
  /** Added by the port-forward gateway change; absent configs are treated as empty. */
  readonly portForwards?: readonly CoderPortForwardProfile[];
}

export interface CoderPortForwardRuntimeStatus {
  readonly id: string;
  readonly status: "starting" | "running" | "stopped" | "error";
  readonly error?: string;
}

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
  readonly status: "running" | "starting" | "stopped" | "unknown";
  readonly updateAvailable: boolean;
  readonly healthy: boolean | null;
  readonly autostopAt: string | null;
  readonly requiredStopAt: string | null;
}

export interface CoderWorkspaceRuntimeStatus {
  readonly status: DiscoveredCoderWorkspace["status"] | "unavailable";
  readonly updateAvailable: boolean;
  readonly healthy: boolean | null;
  readonly autostopAt: string | null;
  readonly requiredStopAt: string | null;
  readonly error?: string;
}

export type WorkspaceDiagnosticPhase =
  | "preflight"
  | "installing_helper"
  | "negotiating_helper"
  | "connected"
  | "disconnected";

export interface WorkspaceDiagnosticEvent {
  readonly id: number;
  readonly attempt: number;
  readonly phase: WorkspaceDiagnosticPhase;
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: number;
  readonly durationMs?: number;
}

export interface CoderWorkspaceResourceUsage {
  readonly cpu: { readonly used: number; readonly total: number; readonly unit: "cores" };
  readonly memory: { readonly used: number; readonly total: number; readonly unit: "B" };
  readonly disk: { readonly used: number; readonly total: number; readonly unit: "B" };
}

export interface CoderWorkspaceMetrics extends CoderWorkspaceResourceUsage {
  readonly healthy: boolean | null;
}

export type CoderDeploymentAuthenticationStatus =
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

async function readResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error((await response.text()) || `Request failed (${response.status}).`);
  }
  return response;
}

export async function loadCoderConfig(): Promise<CoderProfileConfig> {
  const response = await fetch("/api/config", { cache: "no-store" }).then(readResponse);
  return (await response.json()) as CoderProfileConfig;
}

export async function saveCoderConfig(config: CoderProfileConfig): Promise<CoderProfileConfig> {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }).then(readResponse);
  return (await response.json()) as CoderProfileConfig;
}

export async function loginToCoderDeployment(deploymentId: string): Promise<void> {
  await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/login`, {
    method: "POST",
  }).then(readResponse);
}

export async function checkCoderDeploymentAuthentication(
  deploymentId: string,
): Promise<CoderDeploymentAuthenticationStatus> {
  const response = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/auth-status`, {
    method: "POST",
  }).then(readResponse);
  return ((await response.json()) as { readonly status: CoderDeploymentAuthenticationStatus })
    .status;
}

export async function discoverCoderWorkspaces(
  deploymentId: string,
): Promise<readonly DiscoveredCoderWorkspace[]> {
  const response = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/workspaces`, {
    method: "POST",
  }).then(readResponse);
  return ((await response.json()) as { readonly workspaces: readonly DiscoveredCoderWorkspace[] })
    .workspaces;
}

export async function loadCoderPortForwardStatuses(): Promise<
  readonly CoderPortForwardRuntimeStatus[]
> {
  const response = await fetch("/api/port-forwards", { cache: "no-store" }).then(readResponse);
  return (
    (await response.json()) as {
      readonly portForwards: readonly CoderPortForwardRuntimeStatus[];
    }
  ).portForwards;
}

export async function restartCoderPortForward(portForwardId: string): Promise<void> {
  await fetch(`/api/port-forwards/${encodeURIComponent(portForwardId)}/restart`, {
    method: "POST",
  }).then(readResponse);
}

export async function connectCoderWorkspace(
  workspaceId: string,
): Promise<ExecutionEnvironmentDescriptor> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connection`, {
    method: "POST",
  }).then(readResponse);
  return (
    (await response.json()) as {
      readonly info: { readonly environment: ExecutionEnvironmentDescriptor };
    }
  ).info.environment;
}

export async function disconnectCoderWorkspace(workspaceId: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connection`, {
    method: "DELETE",
  }).then(readResponse);
}

export async function loadCoderWorkspaceDiagnostics(
  workspaceId: string,
): Promise<readonly WorkspaceDiagnosticEvent[]> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/diagnostics`, {
    cache: "no-store",
  }).then(readResponse);
  const events = ((await response.json()) as { readonly events?: unknown }).events;
  if (!Array.isArray(events) || !events.every(isWorkspaceDiagnosticEvent)) {
    throw new Error("Coder returned invalid connection diagnostics.");
  }
  return events;
}

const WORKSPACE_DIAGNOSTIC_PHASES = new Set<WorkspaceDiagnosticPhase>([
  "preflight",
  "installing_helper",
  "negotiating_helper",
  "connected",
  "disconnected",
]);

function isWorkspaceDiagnosticEvent(value: unknown): value is WorkspaceDiagnosticEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" &&
    Number.isInteger(record.id) &&
    typeof record.attempt === "number" &&
    Number.isInteger(record.attempt) &&
    typeof record.phase === "string" &&
    WORKSPACE_DIAGNOSTIC_PHASES.has(record.phase as WorkspaceDiagnosticPhase) &&
    (record.status === "running" || record.status === "completed" || record.status === "failed") &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt) &&
    (record.durationMs === undefined ||
      (typeof record.durationMs === "number" &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0))
  );
}

function isResourceMeasurement(
  value: unknown,
  unit: "cores" | "B",
): value is { readonly used: number; readonly total: number; readonly unit: "cores" | "B" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.used === "number" &&
    Number.isFinite(record.used) &&
    record.used >= 0 &&
    typeof record.total === "number" &&
    Number.isFinite(record.total) &&
    record.total > 0 &&
    record.unit === unit
  );
}

export async function loadCoderWorkspaceMetrics(
  workspaceId: string,
): Promise<CoderWorkspaceMetrics> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/metrics`, {
    cache: "no-store",
  }).then(readResponse);
  const value = (await response.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Coder returned invalid workspace resource usage.");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.healthy !== null && typeof record.healthy !== "boolean") ||
    !isResourceMeasurement(record.cpu, "cores") ||
    !isResourceMeasurement(record.memory, "B") ||
    !isResourceMeasurement(record.disk, "B")
  ) {
    throw new Error("Coder returned invalid workspace resource usage.");
  }
  return value as CoderWorkspaceMetrics;
}

export async function restartCoderWorkspace(workspaceId: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/restart`, {
    method: "POST",
  }).then(readResponse);
}

export async function startCoderWorkspace(workspaceId: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/start`, {
    method: "POST",
  }).then(readResponse);
}

export async function stopCoderWorkspace(workspaceId: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/stop`, {
    method: "POST",
  }).then(readResponse);
}

export async function updateCoderWorkspace(workspaceId: string): Promise<void> {
  await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/update`, {
    method: "POST",
  }).then(readResponse);
}

export async function uploadCoderClipboardImage(workspaceId: string, file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Clipboard image must be PNG, JPEG, or WebP.");
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error("Clipboard image exceeds the 20 MiB limit.");
  }
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/clipboard-image`,
    {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    },
  ).then(readResponse);
  const path = ((await response.json()) as { readonly path?: unknown }).path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Clipboard image upload returned an invalid workspace path.");
  }
  return path;
}
