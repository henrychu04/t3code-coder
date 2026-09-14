import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  useUpdateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target: project overrides applied on top of its environment. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings, target?.environmentId ?? null),
    [clientSettings, serverSettings, target?.environmentId],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

/** Where the keys' effective values come from across the selected targets. */
export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistClientSettingsPatch = useUpdateClientSettings();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (plan: ReturnType<typeof planScopedSettingsPatch>) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return Promise.resolve(false);
      }
      return persistScopedSettingsPatch(plan, persistServer, persistClientSettingsPatch).then(
        ({ failedEnvironments, savedEnvironmentCount }) => {
          if (failedEnvironments.length === 0) return true;
          toastManager.add({
            type: "error",
            title:
              savedEnvironmentCount > 0
                ? "Setting saved on some environments"
                : "Setting not saved",
            description: `Could not update ${failedEnvironments.map((environment) => environment.label).join(", ")}.${savedEnvironmentCount > 0 ? " The other selected environments saved the change." : ""}`,
          });
          return false;
        },
      );
    },
    [persistServer, persistClientSettingsPatch],
  );
}

export function useUpdateScopedSettings() {
  const { scope, environments, targets } = useSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => {
      for (const key of [
        "defaultModelSelection",
        "textGenerationModelSelection",
        "sourceControlWriterModelSelection",
      ] as const) {
        const selection = patch[key];
        if (!selection) continue;
        const sourceDriver = environments
          .flatMap((environment) => environment.serverConfig?.providers ?? [])
          .find((provider) => provider.instanceId === selection.instanceId)?.driver;
        const unavailable = targets.find((target) => {
          const provider = environments
            .find((environment) => environment.environmentId === target.environmentId)
            ?.serverConfig?.providers.find(
              (provider) => provider.instanceId === selection.instanceId,
            );
          return (
            !provider?.enabled ||
            provider.driver !== sourceDriver ||
            !provider.models.some((model) => model.slug === selection.model)
          );
        });
        if (unavailable) {
          toastManager.add({
            type: "warning",
            title: "Model unavailable",
            description: `Choose a model available on ${unavailable.label}, or select that workspace separately.`,
          });
          return Promise.resolve(false);
        }
      }
      return run(planScopedSettingsPatch(scope, environments, patch));
    },
    [environments, run, scope, targets],
  );
}

/**
 * Drop the project overrides for `keys` so the selected checkouts inherit
 * again. Rows also render outside the settings layout (provider cards,
 * dialogs), where there is no scope and nothing to clear.
 */
export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

/** Clear `keys` on specific project entries, from an environment scope's chain popover. */
export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (entries: readonly ProjectOverrideEntry[], keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planProjectOverridesClear(context.environments, entries, keys));
    },
    [context, run],
  );
}

export function useOptionalScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const context = useOptionalSettingsScope();
  return context ? scopedSettingsAreMixed(context.targets, keys) : false;
}
