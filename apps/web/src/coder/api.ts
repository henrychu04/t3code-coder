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

export interface CoderProfileConfig {
  readonly version: 1;
  readonly deployments: readonly CoderDeploymentProfile[];
  readonly workspaces: readonly CoderWorkspaceProfile[];
}

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
}

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

export async function saveCoderConfig(
  config: CoderProfileConfig,
): Promise<CoderProfileConfig> {
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
): Promise<boolean> {
  const response = await fetch(
    `/api/deployments/${encodeURIComponent(deploymentId)}/auth-status`,
    { method: "POST" },
  ).then(readResponse);
  return ((await response.json()) as { readonly authenticated: boolean }).authenticated;
}

export async function discoverCoderWorkspaces(
  deploymentId: string,
): Promise<readonly DiscoveredCoderWorkspace[]> {
  const response = await fetch(
    `/api/deployments/${encodeURIComponent(deploymentId)}/workspaces`,
    { method: "POST" },
  ).then(readResponse);
  return ((await response.json()) as { readonly workspaces: readonly DiscoveredCoderWorkspace[] })
    .workspaces;
}

export async function connectCoderWorkspace(
  workspaceId: string,
): Promise<ExecutionEnvironmentDescriptor> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connection`,
    { method: "POST" },
  ).then(readResponse);
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
