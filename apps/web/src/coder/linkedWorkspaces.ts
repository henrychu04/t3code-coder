import type { CoderWorkspaceLinkProfile, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { useServerConfigs } from "../state/entities";
import { useCoder } from "./CoderBootstrap";
import {
  type CoderWorkspaceEnvironment,
  readCoderWorkspaceEnvironments,
  subscribeCoderWorkspaceEnvironments,
} from "./environmentStore";

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();
const NO_LINKS: readonly CoderWorkspaceLinkProfile[] = [];

/**
 * Coder: the machines an environment's agents can work on are the connected workspaces its
 * workspace link rules reach through the gateway hub, while its Linked environments beta is on
 * (upstream's `offersLinkedEnvironments`, `client-runtime/linkRequest.ts`, not carried).
 */
export function linkedWorkspaceEnvironmentIds(input: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null | undefined;
  readonly links: readonly CoderWorkspaceLinkProfile[];
  readonly environments: readonly CoderWorkspaceEnvironment[];
}): ReadonlySet<EnvironmentId> {
  const config = input.serverConfig;
  if (config?.environment.capabilities.peerLinks !== true) return NO_ENVIRONMENTS;
  if (!config.settings.linkedEnvironmentsEnabled) return NO_ENVIRONMENTS;
  const workspaceId = input.environments.find(
    (entry) => entry.descriptor.environmentId === input.environmentId,
  )?.workspaceId;
  if (workspaceId === undefined) return NO_ENVIRONMENTS;
  const targets = new Set(
    input.links.filter((link) => link.from === workspaceId).map((link) => link.to),
  );
  const linked = input.environments
    .filter((entry) => targets.has(entry.workspaceId))
    .map((entry) => entry.descriptor.environmentId);
  return linked.length === 0 ? NO_ENVIRONMENTS : new Set(linked);
}

export function useLinkedWorkspaceEnvironmentIds(
  environmentId: EnvironmentId,
): ReadonlySet<EnvironmentId> {
  const { config } = useCoder();
  const serverConfigs = useServerConfigs();
  const environments = useSyncExternalStore(
    subscribeCoderWorkspaceEnvironments,
    readCoderWorkspaceEnvironments,
    readCoderWorkspaceEnvironments,
  );
  return linkedWorkspaceEnvironmentIds({
    environmentId,
    serverConfig: serverConfigs.get(environmentId),
    links: config.workspaceLinks ?? NO_LINKS,
    environments,
  });
}
