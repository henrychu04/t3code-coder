import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { useCoder } from "../../coder/CoderBootstrap";
import { coderWorkspaceIdForEnvironment } from "../../coder/environmentStore";
import { useActiveEnvironmentId } from "../../state/entities";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { SettingsSelect } from "./SettingsPage";

let lastSettingsWorkspaceId: string | null = null;

export function resolveSettingsWorkspaceId(input: {
  readonly workspaceIds: ReadonlyArray<string>;
  readonly selectedWorkspaceId: string | null;
  readonly activeWorkspaceId: string | null;
}): string | null {
  const available = new Set(input.workspaceIds);
  if (input.selectedWorkspaceId !== null && available.has(input.selectedWorkspaceId)) {
    return input.selectedWorkspaceId;
  }
  if (input.activeWorkspaceId !== null && available.has(input.activeWorkspaceId)) {
    return input.activeWorkspaceId;
  }
  return input.workspaceIds[0] ?? null;
}

export function WorkspaceSettingsTarget(props: {
  readonly children: (environment: EnvironmentPresentation) => ReactNode;
  readonly ariaLabel: string;
}) {
  const { config, connectionErrors, workspaceRuntime } = useCoder();
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();
  const activeWorkspaceId =
    activeEnvironmentId === null ? null : coderWorkspaceIdForEnvironment(activeEnvironmentId);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    lastSettingsWorkspaceId,
  );
  const resolvedWorkspaceId = resolveSettingsWorkspaceId({
    workspaceIds: config.workspaces.map((workspace) => workspace.id),
    selectedWorkspaceId,
    activeWorkspaceId,
  });
  const selectedWorkspace =
    config.workspaces.find((workspace) => workspace.id === resolvedWorkspaceId) ?? null;
  const selectedEnvironment =
    environments.find(
      (environment) =>
        coderWorkspaceIdForEnvironment(environment.environmentId) === resolvedWorkspaceId,
    ) ?? null;

  useEffect(() => {
    if (resolvedWorkspaceId === null || resolvedWorkspaceId === selectedWorkspaceId) return;
    lastSettingsWorkspaceId = resolvedWorkspaceId;
    setSelectedWorkspaceId(resolvedWorkspaceId);
  }, [resolvedWorkspaceId, selectedWorkspaceId]);

  const workspaceLabel = (workspaceId: string) => {
    const workspace = config.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) return workspaceId;
    const deployment = config.deployments.find((entry) => entry.id === workspace.deploymentId);
    return deployment ? `${deployment.name} · ${workspace.name}` : workspace.name;
  };

  const statusMessage = (() => {
    if (!selectedWorkspace) return "Add a workspace in Coder connections to manage its settings.";
    const runtime = workspaceRuntime[selectedWorkspace.id];
    if (runtime?.status === "stopped") {
      return `${workspaceLabel(selectedWorkspace.id)} is stopped. Start it from Coder connections to manage its settings.`;
    }
    if (runtime?.status === "starting")
      return `${workspaceLabel(selectedWorkspace.id)} is starting…`;
    if (runtime?.status === "unavailable") {
      return `${workspaceLabel(selectedWorkspace.id)} is unavailable. Check it in Coder connections.`;
    }
    if (connectionErrors[selectedWorkspace.id]) {
      return `Could not connect to ${workspaceLabel(selectedWorkspace.id)}. Check it in Coder connections.`;
    }
    return `Connecting to ${workspaceLabel(selectedWorkspace.id)}…`;
  })();

  return (
    <>
      {selectedWorkspace ? (
        <div className="flex items-center justify-between gap-4 px-3 pb-2 sm:px-4">
          <span className="text-sm font-medium">Workspace</span>
          <SettingsSelect
            ariaLabel={props.ariaLabel}
            onChange={(workspaceId) => {
              if (!config.workspaces.some((workspace) => workspace.id === workspaceId)) return;
              lastSettingsWorkspaceId = workspaceId;
              setSelectedWorkspaceId(workspaceId);
            }}
            value={selectedWorkspace.id}
          >
            {config.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspaceLabel(workspace.id)}
              </option>
            ))}
          </SettingsSelect>
        </div>
      ) : null}
      {selectedEnvironment?.serverConfig ? (
        props.children(selectedEnvironment)
      ) : (
        <p className="px-3 py-8 text-sm text-muted-foreground sm:px-4">{statusMessage}</p>
      )}
    </>
  );
}
