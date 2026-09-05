import type { CoderProfileConfig } from "@t3tools/contracts";
export type { CoderProfileConfig } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  normalizeCoderDeploymentProfile,
  normalizeCoderPortForwardProfile,
  normalizeCoderWorkspaceProfile,
  type CoderDeploymentProfile,
  type CoderPortForwardProfile,
  type CoderWorkspaceProfile,
} from "./profile.ts";

export const emptyCoderProfileConfig = (): CoderProfileConfig => ({
  version: 1,
  deployments: [],
  workspaces: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined)
    throw new Error(`${field} contains unsupported field ${unexpected}.`);
}

function parseDeployment(value: unknown): CoderDeploymentProfile {
  if (!isRecord(value)) throw new Error("Coder deployment profile must be an object.");
  requireAllowedKeys(value, ["id", "name", "url", "executable"], "Coder deployment profile");
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string"
  ) {
    throw new Error("Coder deployment profile is missing an id, name, or URL.");
  }
  if (value.executable !== undefined && typeof value.executable !== "string") {
    throw new Error("Coder executable must be a string.");
  }
  return normalizeCoderDeploymentProfile({
    id: value.id,
    name: value.name,
    url: value.url,
    ...(value.executable === undefined ? {} : { executable: value.executable }),
  });
}

function parseWorkspace(value: unknown): CoderWorkspaceProfile {
  if (!isRecord(value)) throw new Error("Coder workspace profile must be an object.");
  requireAllowedKeys(
    value,
    // workspaceRoot is accepted only to migrate version-1 configs written by
    // earlier Coder-only builds. Projects now live exclusively in the helper.
    ["id", "name", "deploymentId", "workspace", "workspaceRoot"],
    "Coder workspace profile",
  );
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.deploymentId !== "string" ||
    typeof value.workspace !== "string"
  ) {
    throw new Error("Coder workspace profile is missing an id, deployment id, or workspace name.");
  }
  if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== "string") {
    throw new Error("Legacy workspace root must be a string.");
  }
  return normalizeCoderWorkspaceProfile({
    id: value.id,
    name: value.name,
    deploymentId: value.deploymentId,
    workspace: value.workspace,
  });
}

function parsePortForward(value: unknown): CoderPortForwardProfile {
  if (!isRecord(value)) throw new Error("Coder port forward must be an object.");
  requireAllowedKeys(
    value,
    ["id", "workspaceId", "protocol", "localPort", "remotePort"],
    "Coder port forward",
  );
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.protocol !== "string" ||
    typeof value.localPort !== "number" ||
    typeof value.remotePort !== "number"
  ) {
    throw new Error("Coder port forward is missing an id, workspace id, protocol, or port.");
  }
  return normalizeCoderPortForwardProfile({
    id: value.id,
    workspaceId: value.workspaceId,
    protocol: value.protocol as "tcp" | "udp",
    localPort: value.localPort,
    remotePort: value.remotePort,
  });
}

function requireUniqueIds(values: readonly { readonly id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate ${field} id: ${value.id}.`);
    ids.add(value.id);
  }
}

export function parseCoderProfileConfig(value: unknown): CoderProfileConfig {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported Coder profile configuration version.");
  }
  requireAllowedKeys(
    value,
    ["version", "deployments", "workspaces", "portForwards"],
    "Coder profile config",
  );
  if (!Array.isArray(value.deployments) || !Array.isArray(value.workspaces)) {
    throw new Error("Coder profile configuration must contain deployment and workspace arrays.");
  }
  if (value.portForwards !== undefined && !Array.isArray(value.portForwards)) {
    throw new Error("Coder profile configuration port forwards must be an array.");
  }

  const deployments = value.deployments.map(parseDeployment);
  const workspaces = value.workspaces.map(parseWorkspace);
  const portForwards = (value.portForwards ?? []).map(parsePortForward);
  requireUniqueIds(deployments, "deployment");
  requireUniqueIds(workspaces, "workspace");
  requireUniqueIds(portForwards, "port forward");

  const deploymentIds = new Set(deployments.map((deployment) => deployment.id));
  const workspaceTargets = new Set<string>();
  for (const workspace of workspaces) {
    if (!deploymentIds.has(workspace.deploymentId)) {
      throw new Error(
        `Coder workspace ${workspace.id} references unknown deployment ${workspace.deploymentId}.`,
      );
    }
    const target = `${workspace.deploymentId}\0${workspace.workspace}`;
    if (workspaceTargets.has(target)) {
      throw new Error(
        `Coder workspace ${workspace.workspace} is configured more than once for deployment ${workspace.deploymentId}.`,
      );
    }
    workspaceTargets.add(target);
  }
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const localPorts = new Set<string>();
  for (const portForward of portForwards) {
    if (!workspaceIds.has(portForward.workspaceId)) {
      throw new Error(
        `Coder port forward ${portForward.id} references unknown workspace ${portForward.workspaceId}.`,
      );
    }
    const localTarget = `${portForward.protocol}:${portForward.localPort}`;
    if (localPorts.has(localTarget)) {
      throw new Error(
        `Local ${portForward.protocol.toUpperCase()} port ${portForward.localPort} is configured more than once.`,
      );
    }
    localPorts.add(localTarget);
  }
  return {
    version: 1,
    deployments,
    workspaces,
    ...(value.portForwards === undefined ? {} : { portForwards }),
  };
}

export async function loadCoderProfileConfig(configPath: string): Promise<CoderProfileConfig> {
  try {
    return parseCoderProfileConfig(
      JSON.parse(await NodeFS.readFile(configPath, "utf8")) as unknown,
    );
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return emptyCoderProfileConfig();
    throw cause;
  }
}

export async function saveCoderProfileConfig(
  configPath: string,
  config: CoderProfileConfig,
): Promise<void> {
  const normalized = parseCoderProfileConfig(config);
  const directory = NodePath.dirname(configPath);
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  await NodeFS.mkdir(directory, { recursive: true });
  try {
    await NodeFS.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
    });
    await NodeFS.rename(temporaryPath, configPath);
  } finally {
    await NodeFS.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
