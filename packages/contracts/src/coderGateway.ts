// Non-secret loopback gateway wire types. No process or filesystem imports.
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
