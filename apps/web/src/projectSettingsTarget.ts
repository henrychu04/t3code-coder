import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";

export function projectSettingsTarget(project: { environmentId: EnvironmentId; id: ProjectId }) {
  return {
    to: "/projects/$projectKey" as const,
    // The router encodes the path parameter. Do not pre-encode it like a DOM anchor.
    params: { projectKey: JSON.stringify([project.environmentId, project.id]) },
  };
}

export function parseProjectSettingsKey(key: string): ScopedProjectRef | null {
  try {
    const value: unknown = JSON.parse(key);
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0)
    )
      return null;
    return { environmentId: EnvironmentId.make(value[0]), projectId: ProjectId.make(value[1]) };
  } catch {
    return null;
  }
}
