import {
  AuthMcpClientAccess,
  type CoderDeploymentProfile,
  type CoderWorkspaceLinkProfile,
  type CoderWorkspaceProfile,
  type CoderPortForwardProfile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
export type {
  CoderDeploymentProfile,
  CoderWorkspaceLinkProfile,
  CoderWorkspaceProfile,
  CoderPortForwardProfile,
} from "@t3tools/contracts";

const isLinkAccess = Schema.is(AuthMcpClientAccess);

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
  const id = requireSingleLine(profile.id, "Coder deployment id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("Coder deployment id contains unsupported characters.");
  }
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
    id,
    name: requireSingleLine(profile.name, "Coder deployment name"),
    url: url.href.replace(/\/$/, ""),
    ...(executable === undefined ? {} : { executable }),
  };
}

export function normalizeCoderWorkspaceProfile(
  profile: CoderWorkspaceProfile,
): CoderWorkspaceProfile {
  const workspace = requireSingleLine(profile.workspace, "Coder workspace name");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(workspace)) {
    throw new Error("Coder workspace name must be a workspace or owner/workspace target.");
  }
  return {
    id: requireSingleLine(profile.id, "Coder workspace id"),
    name: requireSingleLine(profile.name, "Coder workspace profile name"),
    deploymentId: requireSingleLine(profile.deploymentId, "Coder deployment id"),
    workspace,
  };
}

function normalizePort(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${field} must be an integer between 1 and 65535.`);
  }
  return value;
}

export function normalizeCoderPortForwardProfile(
  profile: CoderPortForwardProfile,
): CoderPortForwardProfile {
  const id = requireSingleLine(profile.id, "Coder port forward id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("Coder port forward id contains unsupported characters.");
  }
  if (profile.protocol !== "tcp" && profile.protocol !== "udp") {
    throw new Error("Coder port forward protocol must be TCP or UDP.");
  }
  return {
    id,
    workspaceId: requireSingleLine(profile.workspaceId, "Coder port forward workspace id"),
    protocol: profile.protocol,
    localPort: normalizePort(profile.localPort, "Local port"),
    remotePort: normalizePort(profile.remotePort, "Remote port"),
  };
}

export function normalizeCoderWorkspaceLinkProfile(
  profile: CoderWorkspaceLinkProfile,
): CoderWorkspaceLinkProfile {
  const id = requireSingleLine(profile.id, "Coder workspace link id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("Coder workspace link id contains unsupported characters.");
  }
  const from = requireSingleLine(profile.from, "Coder workspace link source");
  const to = requireSingleLine(profile.to, "Coder workspace link target");
  if (from === to) throw new Error("A workspace link must name two different workspaces.");
  if (!isLinkAccess(profile.access)) {
    throw new Error("Coder workspace link access is not a supported access mode.");
  }
  return { id, from, to, access: profile.access };
}
