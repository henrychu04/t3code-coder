import type { ModelSelection, ProjectScript, ThreadEnvMode } from "@t3tools/contracts";

export interface ProjectSettingsValues {
  title: string;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode: ThreadEnvMode | null;
  autoPull: boolean;
  scripts: ReadonlyArray<ProjectScript>;
}

type ProjectSettingsSource = Omit<ProjectSettingsValues, "defaultThreadEnvMode" | "autoPull"> & {
  defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
  autoPull?: boolean | undefined;
};

export function projectSettingsValues(project: ProjectSettingsSource): ProjectSettingsValues {
  return {
    title: project.title,
    defaultModelSelection: project.defaultModelSelection,
    defaultThreadEnvMode: project.defaultThreadEnvMode ?? null,
    autoPull: project.autoPull ?? false,
    scripts: project.scripts,
  };
}

export function projectSettingsChanged(
  a: ProjectSettingsSource,
  b: ProjectSettingsSource,
): boolean {
  return JSON.stringify(projectSettingsValues(a)) !== JSON.stringify(projectSettingsValues(b));
}

export function validateProjectSettings(value: ProjectSettingsValues): string | null {
  if (!value.title.trim()) return "Enter a project name.";
  if (value.scripts.some((script) => !script.name.trim() || !script.command.trim()))
    return "Each script needs a name and command.";
  if (new Set(value.scripts.map((script) => script.id)).size !== value.scripts.length)
    return "Script IDs must be unique.";
  if (value.scripts.filter((script) => script.runOnWorktreeCreate).length > 1)
    return "Only one script can run when a worktree is created.";
  return null;
}
