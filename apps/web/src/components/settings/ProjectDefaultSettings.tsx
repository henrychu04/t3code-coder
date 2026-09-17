import { useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { getModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveCoderProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingResetButton } from "./SettingsPage";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const SETTINGS_PICKER_TRIGGER_CLASSNAME =
  "h-8 min-h-8 min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground sm:h-7 sm:min-h-7";

export function ProjectDefaultModelSetting() {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const navigate = useNavigate();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? [];
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveCoderProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = useScopedSettingsMixed(["defaultModelSelection"]);

  const unavailable = connectedEnvironments.length === 0;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const config = environment?.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveCoderProviderInstanceEntries(config.providers),
        candidate.settings,
      ).find((option) => option.instanceId === instanceId);
      const options = getModelOptionsByInstance(
        { ...settings, ...candidate.settings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  }

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    void updateSettings({ defaultModelSelection: value });
  };

  return (
    <SettingsRow
      settingKeys={["defaultModelSelection"]}
      id="default-model"
      title="Model"
      description={
        isProjectScope
          ? "Model for new threads in this project."
          : "Default model for new threads. Projects can override it."
      }
      status={!mixedModel && settings.defaultModelSelection === null ? "Automatic" : undefined}
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label="default model" onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && activeEntry && representative ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative.environmentId}
              disabled={unavailable}
              triggerAriaLabel="Default model"
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerVariant="outline"
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
              onOpenProviderSetup={(instanceId) =>
                void navigate({
                  to: "/settings/providers",
                  search: {
                    project: undefined,
                    checkout: undefined,
                    machine: representative.environmentId,
                    environmentId: representative.environmentId,
                    instanceId,
                  },
                })
              }
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            {!mixedModel ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled}
                triggerVariant="outline"
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">No providers available</span>
            {representative ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/settings/providers",
                    search: {
                      project: undefined,
                      checkout: undefined,
                      machine: representative.environmentId,
                      environmentId: representative.environmentId,
                    },
                  })
                }
              >
                Open provider setup
              </Button>
            ) : null}
          </div>
        )
      }
    />
  );
}

export function ProjectAutoPullSetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      id="automatic-pull"
      title="Automatically pull"
      settingKeys={["defaultAutoPull"]}
      description="Fast-forward clean default-branch checkouts when the workspace helper starts. Projects can override this preference."
      control={
        <ScopedSwitch
          settingKeys={["defaultAutoPull"]}
          aria-label="Automatically pull"
          checked={settings.defaultAutoPull}
          onCheckedChange={(defaultAutoPull) => void update({ defaultAutoPull })}
        />
      }
    />
  );
}
