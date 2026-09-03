import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";
import { resolveCoderTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";
import { ModelEsque } from "./components/chat/providerIconUtils";
import {
  deriveCoderProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "./providerInstances";
import { sortModelsForProviderInstance } from "./modelOrdering";

const DEFAULT_TEXT_GENERATION_INSTANCE_ID = ProviderInstanceId.make("codex");

export interface AppModelOption {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
}

function toAppModelOption(model: ServerProvider["models"][number]): AppModelOption {
  const option: AppModelOption = {
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom,
  };
  if (model.shortName) option.shortName = model.shortName;
  if (model.subProvider) option.subProvider = model.subProvider;
  if (model.isDefault) option.isDefault = true;
  if (model.isLegacy) option.isLegacy = true;
  return option;
}

function readInstanceModelPreferences(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
): { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> } {
  return (
    settings.providerModelPreferences?.[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    }
  );
}

function applyInstanceModelPreferences(
  options: ReadonlyArray<AppModelOption>,
  preferences: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): AppModelOption[] {
  const hiddenModels = new Set(preferences.hiddenModels);
  return sortModelsForProviderInstance(
    options.filter((option) => !hiddenModels.has(option.slug)),
    { modelOrder: preferences.modelOrder },
  );
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
  _selectedModel?: string | null,
): AppModelOption[] {
  const entry = deriveCoderProviderInstanceEntries(providers).find(
    (candidate) => candidate.driverKind === provider,
  );
  if (!entry) return [];
  return getAppModelOptionsForInstance(settings, entry);
}

/**
 * Return the built-in models reported by one supported workspace provider.
 * Stored custom-model data remains decodable for compatibility but is not a
 * selectable T3 Coder product surface.
 */
export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
): AppModelOption[] {
  const options = entry.models.filter((model) => !model.isCustom).map(toAppModelOption);

  return applyInstanceModelPreferences(
    options,
    readInstanceModelPreferences(settings, entry.instanceId),
  );
}

export function resolveAppModelSelection(
  provider: ProviderDriverKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function resolveAppModelSelectionForInstance(
  instanceId: ProviderInstanceId,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string | null {
  const entry = deriveCoderProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!entry) return null;
  const options = getAppModelOptionsForInstance(settings, entry);
  return (
    resolveSelectableModel(entry.driverKind, selectedModel, options) ??
    options.find((option) => option.isDefault)?.slug ??
    options[0]?.slug ??
    null
  );
}

/**
 * Instance-keyed model options for the two built-in workspace providers.
 */
export function getModelOptionsByInstance(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  _selectedInstanceId?: ProviderInstanceId | null,
  _selectedModel?: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
  for (const entry of deriveCoderProviderInstanceEntries(providers)) {
    out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
  }
  return out;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const configuredSelection = settings.textGenerationModelSelection ?? {
    instanceId: DEFAULT_TEXT_GENERATION_INSTANCE_ID,
    model: DEFAULT_TEXT_GENERATION_MODEL,
  };
  const selection = resolveCoderTextGenerationModelSelection(configuredSelection, providers);
  const entries = deriveCoderProviderInstanceEntries(providers);
  const readyEntries = entries.filter(isProviderInstancePickerReady);
  const selectedEntry = readyEntries.find((entry) => entry.instanceId === selection.instanceId);
  const entry = selectedEntry ?? readyEntries[0];
  if (entry) {
    // When the instance changed due to fallback (e.g. selected instance was disabled),
    // don't carry over the old instance's model — use the fallback instance's default.
    const selectedModel = selectedEntry ? selection.model : null;
    const model =
      resolveAppModelSelectionForInstance(entry.instanceId, settings, providers, selectedModel) ??
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind];
    if (!model) {
      return createModelSelection(entry.instanceId, "", []);
    }
    const provider = entry.driverKind;
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider,
      model,
      models: entry.models,
      modelOptions: selectedEntry ? selection.options : undefined,
      planModeEnabled: settings.planModeEnabled,
    });

    return createModelSelection(entry.instanceId, model, modelOptionsForDispatch);
  }

  const supportedProviders = readyEntries.map((entry) => entry.snapshot);
  const provider = resolveSelectableProvider(supportedProviders, null);
  const keptSelectedProvider = false;

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = keptSelectedProvider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, supportedProviders, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(supportedProviders, provider),
    modelOptions: keptSelectedProvider ? selection.options : undefined,
    planModeEnabled: settings.planModeEnabled,
  });

  return createModelSelection(defaultInstanceIdForDriver(provider), model, modelOptionsForDispatch);
}
