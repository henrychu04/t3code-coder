import { ProviderDriverKind, type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";

import { getModelOptionsByInstance, resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveCoderProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { SettingResetButton, SettingsRow, SettingsSection } from "./SettingsPage";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function TextGenerationModelSettings(props: {
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const selection = resolveAppModelSelectionState(props.settings, props.providers);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveCoderProviderInstanceEntries(props.providers),
      props.settings,
    ),
  );
  const modelOptionsByInstance = getModelOptionsByInstance(
    props.settings,
    props.providers,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const provider = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const isDirty = !Equal.equals(
    props.settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsSection
      title="Generated names"
      description="Choose which workspace model T3 uses for automatic names."
    >
      <SettingsRow
        title="Thread title model"
        description="Used for new thread titles and initial branch names."
        resetAction={
          isDirty ? (
            <SettingResetButton
              label="text generation model"
              onClick={() => props.onChange(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection)}
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerAriaLabel="Thread title model"
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onInstanceModelChange={(instanceId, model) => {
                props.onChange(
                  resolveAppModelSelectionState(
                    {
                      ...props.settings,
                      textGenerationModelSelection: createModelSelection(instanceId, model),
                    },
                    props.providers,
                  ),
                );
              }}
            />
            <TraitsPicker
              provider={provider}
              models={instanceEntry?.models ?? []}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options}
              allowPromptInjectedEffort={false}
              planModeEnabled={props.settings.planModeEnabled}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={(nextOptions) => {
                props.onChange(
                  resolveAppModelSelectionState(
                    {
                      ...props.settings,
                      textGenerationModelSelection: createModelSelection(
                        selection.instanceId,
                        selection.model,
                        nextOptions,
                      ),
                    },
                    props.providers,
                  ),
                );
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
