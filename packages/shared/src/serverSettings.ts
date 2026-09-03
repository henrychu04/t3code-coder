import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import { createModelSelection } from "./model.ts";
import { deepMerge } from "./Struct.ts";
import { isCoderProviderInstanceId } from "./coderProviders.ts";

type ProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): ProviderSettings | undefined =>
  (settings.providers as Record<string, ProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instance = settings.providerInstances[selection.instanceId];
  if (instance !== undefined) return resolveProviderInstanceEnabled(instance);
  return (
    isProviderDriverKind(selection.instanceId) &&
    getProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

/**
 * Resolve the model used for generated titles and branch names against the
 * live Coder provider snapshots. Persisted settings express the preference;
 * snapshots decide whether that preference can currently be used.
 */
export function resolveCoderTextGenerationModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const candidates = providers.filter(
    (provider) =>
      isCoderProviderInstanceId(provider.instanceId) &&
      provider.enabled &&
      provider.availability !== "unavailable" &&
      provider.status === "ready" &&
      provider.models.some((model) => !model.isCustom),
  );
  const selectedProvider = candidates.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  const provider = selectedProvider ?? candidates[0];
  if (!provider) return selection;

  const models = provider.models.filter((model) => !model.isCustom);
  const selectedModel = selectedProvider
    ? models.find((model) => model.slug === selection.model)
    : undefined;
  if (selectedModel) return selection;

  const model =
    models.find((candidate) => candidate.isDefault)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider.driver] ??
    DEFAULT_MODEL;
  return createModelSelection(provider.instanceId, model);
}

export function resolveSourceControlWriterModelSelection(settings: ServerSettings): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  return selection && isModelSelectionProviderEnabled(settings, selection)
    ? selection
    : settings.textGenerationModelSelection;
}

const shouldReplaceSelection = (
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean => Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));

const mergeOptions = (
  current: ModelSelection["options"],
  patch: NonNullable<ServerSettingsPatch["textGenerationModelSelection"]>["options"],
) => {
  if (patch === undefined) return current ? [...current] : undefined;
  if (patch.length === 0) return undefined;
  const options = new Map((current ?? []).map((entry) => [entry.id, entry.value]));
  for (const entry of patch) options.set(entry.id, entry.value);
  return [...options].map(([id, value]) => ({ id, value }));
};

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = {
    ...deepMerge(current, patch),
    ...(patch.automaticGitFetchInterval === undefined
      ? {}
      : { automaticGitFetchInterval: patch.automaticGitFetchInterval }),
    ...(patch.sourceControlWriterModelSelection === undefined
      ? {}
      : { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }),
    ...(patch.providerInstances === undefined
      ? {}
      : { providerInstances: patch.providerInstances }),
  };
  if (selectionPatch === undefined) return next;

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceSelection(selectionPatch)
    ? selectionPatch.options
    : mergeOptions(current.textGenerationModelSelection.options, selectionPatch.options);
  return {
    ...next,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
