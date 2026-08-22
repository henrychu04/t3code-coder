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
  readonly workspaceRoot: string;
}

function requireSingleLine(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (/\r|\n|\0/.test(normalized)) {
    throw new Error(`${field} must be a single line.`);
  }
  return normalized;
}

function normalizeCoderExecutable(value: string | undefined): string | undefined {
  const executable = value?.trim();
  if (executable === undefined || executable.length === 0) return undefined;
  const normalized = requireSingleLine(executable, "Coder executable");
  const basename = normalized.split(/[\\/]/).at(-1)?.toLowerCase();
  if (basename !== "coder" && basename !== "coder.exe") {
    throw new Error("Coder executable path must end in coder or coder.exe.");
  }
  return normalized;
}

export function normalizeCoderDeploymentProfile(
  profile: CoderDeploymentProfile,
): CoderDeploymentProfile {
  const rawUrl = requireSingleLine(profile.url, "Coder deployment URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Coder deployment URL must use HTTP or HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Coder deployment URL must not contain credentials.");
  }
  if (url.search.length > 0) {
    throw new Error("Coder deployment URL must not contain query parameters.");
  }
  url.hash = "";

  const executable = normalizeCoderExecutable(profile.executable);
  return {
    id: requireSingleLine(profile.id, "Coder deployment id"),
    name: requireSingleLine(profile.name, "Coder deployment name"),
    url: url.href.replace(/\/$/, ""),
    ...(executable === undefined ? {} : { executable }),
  };
}

export function normalizeCoderWorkspaceProfile(
  profile: CoderWorkspaceProfile,
): CoderWorkspaceProfile {
  const workspaceRoot = requireSingleLine(profile.workspaceRoot, "Workspace root");
  if (!workspaceRoot.startsWith("/") || workspaceRoot.includes("\\")) {
    throw new Error("Workspace root must be an absolute Linux path.");
  }
  const workspace = requireSingleLine(profile.workspace, "Coder workspace name");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(workspace)) {
    throw new Error("Coder workspace name must be a workspace or owner/workspace target.");
  }
  return {
    id: requireSingleLine(profile.id, "Coder workspace id"),
    name: requireSingleLine(profile.name, "Coder project name"),
    deploymentId: requireSingleLine(profile.deploymentId, "Coder deployment id"),
    workspace,
    workspaceRoot,
  };
}
