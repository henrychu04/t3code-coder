import type { CoderProfileConfig } from "@t3tools/coder-cli/configStore";

export class CoderConfigConflictError extends Error {}

/**
 * Coder keeps a deployment's sign-in in the profile directory named by its id, so a saved
 * deployment's URL never changes; otherwise its session would go to the new host.
 */
export function assertDeploymentUrlsUnchanged(
  previous: CoderProfileConfig,
  next: CoderProfileConfig,
) {
  for (const deployment of next.deployments) {
    const saved = previous.deployments.find((entry) => entry.id === deployment.id);
    if (saved !== undefined && saved.url !== deployment.url)
      throw new CoderConfigConflictError(
        `The domain of ${saved.name} cannot change. Add the new domain instead.`,
      );
  }
}

export function workspaceConnectionIsCurrent(
  previous: CoderProfileConfig,
  next: CoderProfileConfig,
  workspaceId: string,
): boolean {
  const previousWorkspace = previous.workspaces.find((entry) => entry.id === workspaceId);
  const nextWorkspace = next.workspaces.find((entry) => entry.id === workspaceId);
  if (previousWorkspace === undefined || nextWorkspace === undefined) return false;
  const previousDeployment = previous.deployments.find(
    (entry) => entry.id === previousWorkspace.deploymentId,
  );
  const nextDeployment = next.deployments.find((entry) => entry.id === nextWorkspace.deploymentId);
  return (
    previousDeployment !== undefined &&
    nextDeployment !== undefined &&
    previousWorkspace.deploymentId === nextWorkspace.deploymentId &&
    previousWorkspace.workspace === nextWorkspace.workspace &&
    previousDeployment.url === nextDeployment.url &&
    previousDeployment.executable === nextDeployment.executable
  );
}

export function portForwardIsCurrent(
  previous: CoderProfileConfig,
  next: CoderProfileConfig,
  portForwardId: string,
): boolean {
  const previousPortForward = previous.portForwards?.find((entry) => entry.id === portForwardId);
  const nextPortForward = next.portForwards?.find((entry) => entry.id === portForwardId);
  return (
    previousPortForward !== undefined &&
    nextPortForward !== undefined &&
    previousPortForward.workspaceId === nextPortForward.workspaceId &&
    previousPortForward.protocol === nextPortForward.protocol &&
    previousPortForward.localPort === nextPortForward.localPort &&
    previousPortForward.remotePort === nextPortForward.remotePort &&
    workspaceConnectionIsCurrent(previous, next, previousPortForward.workspaceId)
  );
}
