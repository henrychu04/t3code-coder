import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
/**
 * Bundled upstream model lifecycle classification.
 *
 * Upstream may refresh this manifest over HTTP. T3 Coder deliberately uses
 * only the bundled copy so provider discovery does not add a T3-owned network
 * request. The file is updated when upstream changes are carried into the
 * fork.
 */
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { codexModelFamily } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import { ProviderCompatibilityPolicy } from "./providerCompatibility.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const ModelManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * ISO date of the last edit. A release bundles its manifest, and a disk
   * cache of an older edit must not outrank it. Optional so older remote
   * files still decode; they count as older than any dated bundle.
   */
  updatedAt: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.Array(ProviderCompatibilityPolicy)),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type ModelManifestData = typeof ModelManifestSchema.Type;

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  slug = driverKind === CODEX_DRIVER_KIND ? codexModelFamily(slug) : slug;
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  if (currentModels.includes(slug)) return false;
  const codexAlias =
    driverKind === CODEX_DRIVER_KIND && slug.endsWith("-codex")
      ? slug.slice(0, -"-codex".length)
      : undefined;
  return codexAlias === undefined || !currentModels.includes(codexAlias);
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

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    readonly current: Effect.Effect<ModelManifestData>;
    readonly refresh: Effect.Effect<ModelManifestData>;
    readonly forceRefresh: Effect.Effect<ModelManifestData>;
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("t3/provider/ModelManifest") {}

export const layer = Layer.succeed(ModelManifest, {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  forceRefresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
});
