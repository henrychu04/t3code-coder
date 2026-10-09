/**
 * ModelManifest — remote provider-model metadata with a bundled offline
 * fallback.
 *
 * Provider catalogs and legacy classification live in `model-manifest.json`.
 * The bundled copy ships with every release; at runtime the service refreshes
 * it from the same file on `main`. Preference order is remote, then the last
 * successful on-disk copy, then the bundle. A failed fetch never fails a
 * provider check.
 *
 * Providers with authoritative discovery can use only the classification
 * overlay. Providers with static catalogs can resolve presentation and
 * capabilities from `providers`, then decode their own allowlisted adapter
 * payload separately.
 *
 * Coder: only the bundled copy is served; see `layerBundled`.
 */
import {
  ModelCapabilities,
  TrimmedNonEmptyString,
  type ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { codexModelFamily } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import { ProviderCompatibilityPolicy } from "./providerCompatibility.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const ManifestModelStatus = Schema.Literals(["current", "legacy"]);

const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: ManifestModelStatus,
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(TrimmedNonEmptyString),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderCatalog = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      chat: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  profiles: Schema.Record(Schema.String, ManifestModelProfile),
  models: Schema.Array(ManifestProviderModel),
});

/**
 * `version` gates breaking schema changes. Provider catalogs are additive so
 * clients that only understand `currentModels` keep accepting this v1 file.
 */
const ModelManifestEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * ISO date of the last edit. A release bundles its manifest, and a disk
   * cache of an older edit must not outrank it. Optional so older remote
   * files still decode; they count as older than any dated bundle.
   */
  updatedAt: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.Array(ProviderCompatibilityPolicy)),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Record(Schema.String, ManifestProviderCatalog)),
});

const hasValidProviderCatalogReferences = (
  manifest: typeof ModelManifestEnvelopeSchema.Type,
): boolean =>
  Object.values(manifest.providers ?? {}).every((catalog) => {
    const slugs = new Set<string>();
    const modelsAreValid = catalog.models.every((model) => {
      if (slugs.has(model.slug)) return false;
      slugs.add(model.slug);
      return model.profile === undefined || catalog.profiles[model.profile] !== undefined;
    });
    return (
      modelsAreValid && (catalog.defaults?.chat === undefined || slugs.has(catalog.defaults.chat))
    );
  });

const ModelManifestSchema = ModelManifestEnvelopeSchema.pipe(
  Schema.check(
    Schema.makeFilter(hasValidProviderCatalogReferences, {
      expected: "unique model slugs and existing model and profile references",
    }),
    Schema.makeFilter(hasValidClaudeManifestAdapters, {
      expected: "valid Claude adapter metadata",
    }),
  ),
);
export type ModelManifestData = typeof ModelManifestSchema.Type;

export interface ResolvedManifestModel {
  readonly model: ServerProviderModel;
  readonly adapter: unknown;
  readonly profileAdapter: unknown;
}

export interface ResolvedProviderCatalog {
  readonly models: ReadonlyArray<ResolvedManifestModel>;
  readonly defaults: {
    readonly chat: string | undefined;
  };
}

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

/** Resolve provider-neutral model presentation and capability data. */
export function resolveProviderCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ResolvedProviderCatalog | null {
  const catalog = manifest.providers?.[driverKind];
  if (!catalog) return null;

  const seen = new Set<string>();
  const models: Array<ResolvedManifestModel> = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);

    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    if (entry.profile && !profile) return null;

    models.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        ...(entry.shortName ? { shortName: entry.shortName } : {}),
        ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
        ...(entry.aliases ? { aliases: entry.aliases } : {}),
        ...(entry.badge ? { badge: entry.badge } : {}),
        isCustom: false,
        ...(catalog.defaults?.chat === entry.slug ? { isDefault: true } : {}),
        ...(entry.status === "legacy" ? { isLegacy: true } : {}),
        capabilities: profile?.capabilities ?? null,
      },
      adapter: entry.adapter,
      profileAdapter: profile?.adapter,
    });
  }

  if (catalog.defaults?.chat !== undefined && !seen.has(catalog.defaults.chat)) return null;

  return {
    models,
    defaults: {
      chat: catalog.defaults?.chat,
    },
  };
}

/** True when the manifest classifies `slug` as legacy for `driverKind`. */
function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const family = driverKind === "codex" ? codexModelFamily(slug) : slug;
  const catalog = manifest.providers?.[driverKind]?.models;
  const catalogModel =
    catalog?.find((model) => model.slug === slug) ??
    catalog?.find((model) => model.slug === family);
  if (catalogModel) return catalogModel.status === "legacy";
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  return !currentModels.includes(slug) && !currentModels.includes(family);
}

/**
 * Reclassifies every built-in model on a snapshot draft against the manifest.
 * Custom models are user-defined and never reclassified.
 */
export function applyModelManifest(
  draft: ServerProviderDraft,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return {
    ...draft,
    models: applyManifestDefault(
      classifyModels(draft.models, manifest, driverKind),
      manifest,
      driverKind,
    ),
  };
}

/** The manifest's chat default for `driverKind`, when it names one. */
export function manifestDefaultModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): string | undefined {
  return manifest.providers?.[driverKind]?.defaults?.chat;
}

/**
 * Moves `isDefault` to the manifest's chat default when the catalog carries
 * it. Providers that learn their default from the runtime (Antigravity takes
 * Google's current model) can be overridden here without a release. Aliases
 * that pointed at the old default move with the flag so the shared
 * "provider default" alias keeps resolving.
 */
export function applyManifestDefault(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  const requestedSlug = manifestDefaultModel(manifest, driverKind);
  if (requestedSlug === undefined) return models;
  const slug =
    models.find((model) => model.slug === requestedSlug)?.slug ??
    (driverKind === "codex"
      ? models.find(
          (model) =>
            !model.isCustom && codexModelFamily(model.slug) === codexModelFamily(requestedSlug),
        )?.slug
      : undefined);
  if (slug === undefined) return models;
  const previous = models.find((model) => model.isDefault && model.slug !== slug);
  if (!previous) return models;
  const movedAliases = previous.aliases ?? [];
  return models.map((model) => {
    if (model.slug === previous.slug) {
      const { isDefault: _isDefault, aliases: _aliases, ...rest } = model;
      return rest;
    }
    if (model.slug === slug) {
      const aliases = [...new Set([...(model.aliases ?? []), ...movedAliases])];
      return { ...model, isDefault: true, ...(aliases.length > 0 ? { aliases } : {}) };
    }
    return model;
  });
}

/** Model-level half of `applyModelManifest`, exported for focused tests. */
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

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /** Manifest already in memory (disk cache or bundle); never fetches.
     * Snapshot classification reads this, so it never waits on the network. */
    readonly current: Effect.Effect<ModelManifestData>;
    /** Manifest after a TTL-gated remote refresh; never fails. */
    readonly refresh: Effect.Effect<ModelManifestData>;
    /** Explicit refresh bypasses freshness and retry timers, retaining last-good data. */
    readonly forceRefresh: Effect.Effect<ModelManifestData>;
    /** Forks `refresh` into the service's own scope. Drivers call this from
     * provider checks: the fetch is process-shared state, so it must survive
     * the teardown of whichever instance happened to trigger it. */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("t3/provider/ModelManifest") {}

/** Constant service backing the bundled-data test layer. */
const BundledOnlyModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  forceRefresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
};

export const layerTest = Layer.succeed(ModelManifest, BundledOnlyModelManifest);

// Coder: the helper makes no T3-owned network request, so upstream's hourly remote refresh and
// its disk cache are omitted. The helper serves only the manifest bundled with each release;
// upstream syncs update it.
export const layerBundled = layerTest;
