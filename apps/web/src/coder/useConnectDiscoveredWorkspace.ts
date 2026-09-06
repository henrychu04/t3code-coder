import { useCoder } from "./CoderBootstrap";
import { startCoderWorkspace, type DiscoveredCoderWorkspace } from "./api";
import { randomUUID } from "../lib/utils";

/** Persist a discovered target before starting and connecting its workspace. */
export function useConnectDiscoveredWorkspace() {
  const { config, saveConfig, connectWorkspace } = useCoder();
  return async (deploymentId: string, workspace: DiscoveredCoderWorkspace) => {
    const existing = config.workspaces.find(
      (entry) => entry.deploymentId === deploymentId && entry.workspace === workspace.target,
    );
    const profile = existing ?? {
      id: `workspace-${randomUUID()}`,
      name: workspace.name,
      deploymentId,
      workspace: workspace.target,
    };
    if (!existing) await saveConfig({ ...config, workspaces: [...config.workspaces, profile] });
    if (workspace.status === "stopped") await startCoderWorkspace(profile.id);
    return connectWorkspace(profile.id);
  };
}
