import type { ThreadEnvMode } from "@t3tools/contracts";

/** Resolves explicit project settings, then repository configuration, then workspace defaults. */
export function resolveDefaultThreadEnvMode(sources: {
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly repositoryDefault?: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return sources.projectSetting ?? sources.repositoryDefault ?? sources.globalDefault;
}
