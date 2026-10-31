import { reportErrorDiagnostic } from "@t3tools/client-runtime/errors";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import type {
  CoderProfileConfig,
  CoderPortForwardRuntimeStatus,
  DiscoveredCoderWorkspace,
  WorkspaceDiagnosticPhase,
  WorkspaceDiagnosticEvent,
  CoderDeploymentAuthenticationStatus,
} from "@t3tools/contracts";
export type {
  CoderDeploymentProfile,
  CoderWorkspaceProfile,
  CoderPortForwardProfile,
  CoderWorkspaceLinkProfile,
  CoderProfileConfig,
  CoderPortForwardRuntimeStatus,
  DiscoveredCoderWorkspace,
  CoderWorkspaceRuntimeStatus,
  WorkspaceDiagnosticPhase,
  WorkspaceDiagnosticEvent,
  CoderDeploymentAuthenticationStatus,
} from "@t3tools/contracts";
async function fetchCoder(path: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(path, init);
    if (!response.ok) {
      throw new Error((await response.text()) || `Request failed (${response.status}).`);
    }
    return response;
  } catch (error) {
    reportErrorDiagnostic("coder.gateway", error);
    throw error;
  }
}

export async function loadCoderConfig(): Promise<CoderProfileConfig> {
  const response = await fetchCoder("/api/config", { cache: "no-store" });
  return (await response.json()) as CoderProfileConfig;
}

export async function saveCoderConfig(config: CoderProfileConfig): Promise<CoderProfileConfig> {
  const response = await fetchCoder("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  return (await response.json()) as CoderProfileConfig;
}

export async function loginToCoderDeployment(deploymentId: string): Promise<void> {
  await fetchCoder(`/api/deployments/${encodeURIComponent(deploymentId)}/login`, {
    method: "POST",
  });
}

export async function checkCoderDeploymentAuthentication(
  deploymentId: string,
  signal?: AbortSignal,
): Promise<CoderDeploymentAuthenticationStatus> {
  const response = await fetchCoder(
    `/api/deployments/${encodeURIComponent(deploymentId)}/auth-status`,
    {
      method: "POST",
      ...(signal ? { signal } : {}),
    },
  );
  return ((await response.json()) as { readonly status: CoderDeploymentAuthenticationStatus })
    .status;
}

export async function discoverCoderWorkspaces(
  deploymentId: string,
  signal?: AbortSignal,
): Promise<readonly DiscoveredCoderWorkspace[]> {
  const response = await fetchCoder(
    `/api/deployments/${encodeURIComponent(deploymentId)}/workspaces`,
    {
      method: "POST",
      ...(signal ? { signal } : {}),
    },
  );
  return ((await response.json()) as { readonly workspaces: readonly DiscoveredCoderWorkspace[] })
    .workspaces;
}

export async function loadCoderPortForwardStatuses(
  signal?: AbortSignal,
): Promise<readonly CoderPortForwardRuntimeStatus[]> {
  const response = await fetchCoder("/api/port-forwards", {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return (
    (await response.json()) as {
      readonly portForwards: readonly CoderPortForwardRuntimeStatus[];
    }
  ).portForwards;
}

/** The requested local port, or the next one free for a TCP forward on this computer. */
export async function findFreeCoderForwardPort(port: number): Promise<number> {
  const response = await fetchCoder("/api/port-forwards/free-port", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port }),
  });
  return ((await response.json()) as { readonly port: number }).port;
}

export async function restartCoderPortForward(portForwardId: string): Promise<void> {
  await fetchCoder(`/api/port-forwards/${encodeURIComponent(portForwardId)}/restart`, {
    method: "POST",
  });
}

export async function connectCoderWorkspace(
  workspaceId: string,
): Promise<ExecutionEnvironmentDescriptor> {
  const response = await fetchCoder(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connection`,
    {
      method: "POST",
    },
  );
  return (
    (await response.json()) as {
      readonly info: { readonly environment: ExecutionEnvironmentDescriptor };
    }
  ).info.environment;
}

export async function disconnectCoderWorkspace(workspaceId: string): Promise<void> {
  await fetchCoder(`/api/workspaces/${encodeURIComponent(workspaceId)}/connection`, {
    method: "DELETE",
  });
}

/** Bytes sent to and received from the connected helper since its connection opened. */
export interface CoderWorkspaceTraffic {
  readonly sentBytes: number;
  readonly receivedBytes: number;
}

export async function loadCoderWorkspaceDiagnostics(workspaceId: string): Promise<{
  readonly events: readonly WorkspaceDiagnosticEvent[];
  readonly traffic: CoderWorkspaceTraffic | null;
}> {
  const response = await fetchCoder(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/diagnostics`,
    {
      cache: "no-store",
    },
  );
  const body = (await response.json()) as { readonly events?: unknown; readonly traffic?: unknown };
  const events = body.events;
  if (!Array.isArray(events) || !events.every(isWorkspaceDiagnosticEvent)) {
    throw new Error("Coder returned invalid connection diagnostics.");
  }
  const traffic = body.traffic as Partial<CoderWorkspaceTraffic> | undefined;
  return {
    events,
    traffic:
      typeof traffic?.sentBytes === "number" && typeof traffic.receivedBytes === "number"
        ? { sentBytes: traffic.sentBytes, receivedBytes: traffic.receivedBytes }
        : null,
  };
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

export async function restartCoderWorkspace(workspaceId: string): Promise<void> {
  await fetchCoder(`/api/workspaces/${encodeURIComponent(workspaceId)}/restart`, {
    method: "POST",
  });
}

export async function startCoderWorkspace(workspaceId: string): Promise<void> {
  await fetchCoder(`/api/workspaces/${encodeURIComponent(workspaceId)}/start`, {
    method: "POST",
  });
}

export async function stopCoderWorkspace(workspaceId: string): Promise<void> {
  await fetchCoder(`/api/workspaces/${encodeURIComponent(workspaceId)}/stop`, {
    method: "POST",
  });
}

export async function updateCoderWorkspace(workspaceId: string): Promise<void> {
  await fetchCoder(`/api/workspaces/${encodeURIComponent(workspaceId)}/update`, {
    method: "POST",
  });
}
