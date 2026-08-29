/**
 * Bundled upstream model lifecycle classification.
 *
 * Upstream may refresh this manifest over HTTP. T3 Coder deliberately uses
 * only the bundled copy so provider discovery does not add a T3-owned network
 * request. The file is updated when upstream changes are carried into the
 * fork.
 */
import type { ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const ModelManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type ModelManifestData = typeof ModelManifestSchema.Type;

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

export function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  return !currentModels.includes(slug);
}

export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    if (isLegacyModel(manifest, driverKind, model.slug)) {
      return model.isLegacy ? model : { ...model, isLegacy: true };
    }
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

export function applyBundledModelManifest(
  draft: ServerProviderDraft,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return {
    ...draft,
    models: classifyModels(draft.models, BUNDLED_MODEL_MANIFEST, driverKind),
  };
}
