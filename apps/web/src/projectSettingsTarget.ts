import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export function projectSettingsTarget(project: { environmentId: EnvironmentId; id: ProjectId }) {
  return {
    to: "/settings/source-control" as const,
    hash: `project-${encodeURIComponent(JSON.stringify([project.environmentId, project.id]))}`,
  };
}
