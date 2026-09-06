import { useCoder } from "./CoderBootstrap";
import { startCoderWorkspace, type DiscoveredCoderWorkspace } from "./api";
import { randomUUID } from "../lib/utils";

/** Persist a discovered target before starting and connecting its workspace. */
export function useConnectDiscoveredWorkspace() {
  const { config, saveConfig, connectWorkspace } = useCoder();
  return async (deploymentId: string, workspace: DiscoveredCoderWorkspace) => {
    if (workspace.status !== "running" && workspace.status !== "stopped") {
      throw new Error(
        "Select a running or stopped workspace. Refresh the workspace list and try again.",
      );
    }
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
