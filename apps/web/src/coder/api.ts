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
  readonly status: "starting" | "running" | "error";
  readonly error?: string;
}

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
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
