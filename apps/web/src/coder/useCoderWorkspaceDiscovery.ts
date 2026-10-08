import { useCallback, useEffect, useRef, useState } from "react";

import {
  discoverCoderWorkspaces,
  type CoderProfileConfig,
  type DiscoveredCoderWorkspace,
} from "./api";
import { useCoder } from "./CoderBootstrap";

export type CoderDeploymentDiscovery =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly workspaces: readonly DiscoveredCoderWorkspace[] }
  | { readonly status: "error"; readonly error: string };

export interface CoderDeploymentWorkspaces {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly discovery: CoderDeploymentDiscovery;
}

/**
 * Lists each domain's workspaces that have no connected environment yet, so a project folder can
 * be chosen on any of them. Configured but disconnected workspaces are included.
 */
export function addableCoderWorkspaces(
  config: CoderProfileConfig,
  discoveries: Readonly<Record<string, CoderDeploymentDiscovery>>,
  connectedWorkspaceIds: ReadonlySet<string>,
): readonly CoderDeploymentWorkspaces[] {
  return config.deployments.flatMap((deployment): CoderDeploymentWorkspaces[] => {
    const discovery = discoveries[deployment.id];
    if (discovery === undefined) return [];
    if (discovery.status !== "ready") {
      return [{ deploymentId: deployment.id, deploymentName: deployment.name, discovery }];
    }
    const workspaces = discovery.workspaces.filter((workspace) => {
      const profile = config.workspaces.find(
        (entry) => entry.deploymentId === deployment.id && entry.workspace === workspace.target,
      );
      return profile === undefined || !connectedWorkspaceIds.has(profile.id);
    });
    return workspaces.length === 0
      ? []
      : [
          {
            deploymentId: deployment.id,
            deploymentName: deployment.name,
            discovery: { status: "ready", workspaces },
          },
        ];
  });
}

/** Discovers workspaces on every configured domain on demand. */
export function useCoderWorkspaceDiscovery(connectedWorkspaceIds: ReadonlySet<string>) {
  const { config } = useCoder();
  const [discoveries, setDiscoveries] = useState<
    Readonly<Record<string, CoderDeploymentDiscovery>>
  >({});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const discover = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setDiscoveries(
      Object.fromEntries(
        config.deployments.map((deployment) => [deployment.id, { status: "loading" }]),
      ),
    );
    for (const deployment of config.deployments) {
      void discoverCoderWorkspaces(deployment.id, current.signal).then(
        (workspaces) => {
          if (current.signal.aborted) return;
          setDiscoveries((previous) => ({
            ...previous,
            [deployment.id]: { status: "ready", workspaces },
          }));
        },
        (cause: unknown) => {
          if (current.signal.aborted) return;
          setDiscoveries((previous) => ({
            ...previous,
            [deployment.id]: {
              status: "error",
              error: cause instanceof Error ? cause.message : "Could not list workspaces.",
            },
          }));
        },
      );
    }
  }, [config.deployments]);

  return {
    deployments: addableCoderWorkspaces(config, discoveries, connectedWorkspaceIds),
    discover,
  };
}
