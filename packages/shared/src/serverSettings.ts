import {
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import { createModelSelection } from "./model.ts";
import { deepMerge } from "./Struct.ts";

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
