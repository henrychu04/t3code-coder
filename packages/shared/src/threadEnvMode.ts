import type { ThreadEnvMode } from "@t3tools/contracts";

/** Resolves the workspace-owned project setting before the global default. */
export function resolveDefaultThreadEnvMode(sources: {
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return sources.projectSetting ?? sources.globalDefault;
}
