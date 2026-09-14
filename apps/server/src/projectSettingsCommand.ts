import type {
  OrchestrationCommand,
  ProjectSettingsOverrides,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

/** Keep retained project commands compatible with the canonical settings record. */
export function projectSettingsCommandPatch(
  settings: ServerSettings,
  command: OrchestrationCommand,
): ServerSettingsPatch | null {
  if (command.type !== "project.create" && command.type !== "project.meta.update") return null;
  const next: { -readonly [K in keyof ProjectSettingsOverrides]: ProjectSettingsOverrides[K] } = {
    ...settings.projectSettingsOverrides[command.projectId],
  };
  let changed = false;
  const fields = {
    defaultModelSelection: command.defaultModelSelection,
    defaultThreadEnvMode:
      command.type === "project.meta.update" ? command.defaultThreadEnvMode : undefined,
  };
  for (const key of ["defaultModelSelection", "defaultThreadEnvMode"] as const) {
    if (fields[key] === undefined) continue;
    changed = true;
    const value = fields[key];
    if (value === null) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  if (command.type === "project.meta.update") {
    if (command.autoPull !== undefined) {
      next.defaultAutoPull = command.autoPull;
      changed = true;
    }
    if (command.scripts !== undefined) {
      next.defaultProjectScripts = command.scripts;
      changed = true;
    }
  }
  return changed
    ? { projectSettingsOverrides: { [command.projectId]: Object.keys(next).length ? next : null } }
    : null;
}
