import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ModelManifest from "./ModelManifest.ts";

/**
 * Test policy: this file covers manifest machinery, not manifest contents.
 * Do not add assertions for real model slugs, names, status, aliases, or
 * profiles when editing model-manifest.json. Add tests only when fetch/cache
 * behavior or the provider-neutral resolver semantics change, and use
 * synthetic models for resolver coverage.
 */

const CODEX = ProviderDriverKind.make("codex");
const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("classifies qualified Codex families without changing their wire ids", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: { codex: ["gpt-test"] },
    };
    const models = [
      model({ slug: "openai.gpt-test", isLegacy: true }),
      model({ slug: "openai.gpt-old" }),
    ];
    assert.deepStrictEqual(
      ModelManifest.classifyModels(models, manifest, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["openai.gpt-test", false],
        ["openai.gpt-old", true],
      ],
    );
  });
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: { codex: ["current-a", "current-b"] },
    };
    const models = [
      model({ slug: "current-a" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "current-b", isLegacy: true }),
      model({ slug: "old-model" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      ModelManifest.classifyModels(models, manifest, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["current-a", false],
        ["current-b", false],
        ["old-model", true],
        ["my-own-model", false],
      ],
    );
  });
});

describe("applyManifestDefault", () => {
  it("resolves the manifest default to the qualified live model", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: { codex: { models: [], profiles: {}, defaults: { chat: "gpt-test" } } },
    };
    const models = [
      model({ slug: "openai.gpt-old", isDefault: true }),
      model({ slug: "openai.gpt-test" }),
    ];
    assert.strictEqual(
      ModelManifest.applyManifestDefault(models, manifest, CODEX).find((entry) => entry.isDefault)
        ?.slug,
      "openai.gpt-test",
    );
  });
  it("moves the default flag and its aliases to the manifest's chat default", () => {
    const driver = ProviderDriverKind.make("antigravity");
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        antigravity: {
          defaults: { chat: "gemini-new" },
          profiles: {},
          models: [{ slug: "gemini-new", name: "New", status: "current" }],
        },
      },
    };
    const models = [
      model({ slug: "gemini-old", isDefault: true, aliases: ["antigravity-default"] }),
      model({ slug: "gemini-new" }),
    ];
    assert.deepStrictEqual(ModelManifest.applyManifestDefault(models, manifest, driver), [
      model({ slug: "gemini-old" }),
      model({ slug: "gemini-new", isDefault: true, aliases: ["antigravity-default"] }),
    ]);
    // The account does not offer the manifest default: keep the runtime's choice.
    assert.deepStrictEqual(
      ModelManifest.applyManifestDefault(models.slice(0, 1), manifest, driver),
      models.slice(0, 1),
    );
  });
});

describe("resolveProviderCatalog", () => {
  it("resolves generic model presentation through a reusable profile", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          defaults: { chat: "model-next" },
          profiles: {
            standard: {
              capabilities: {
                optionDescriptors: [
                  {
                    id: "mode",
                    label: "Mode",
                    type: "select",
                    options: [{ id: "fast", label: "Fast", isDefault: true }],
                  },
                ],
              },
              adapter: { opaque: true },
            },
          },
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              aliases: ["next"],
              status: "current",
              badge: "new",
              profile: "standard",
            },
          ],
        },
      },
    };

    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      ProviderDriverKind.make("synthetic"),
    );
    assert.deepStrictEqual(catalog?.models[0], {
      model: {
        slug: "model-next",
        name: "Model Next",
        aliases: ["next"],
        badge: "new",
        isCustom: false,
        isDefault: true,
        capabilities: manifest.providers!.synthetic!.profiles.standard!.capabilities!,
      },
      adapter: undefined,
      profileAdapter: { opaque: true },
    });
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")),
      );
    }
  });
});

// Remote fixtures date after the bundle so a fetch still outranks it.

// Coder: the helper serves only the bundled manifest; upstream's fetch and cache tests are omitted.
describe("ModelManifest bundled layer", () => {
  it.effect("serves the bundled manifest without a refresh source", () =>
    Effect.gen(function* () {
      const service = yield* ModelManifest.ModelManifest;
      yield* service.refreshInBackground;
      assert.deepStrictEqual(yield* service.current, ModelManifest.BUNDLED_MODEL_MANIFEST);
      assert.deepStrictEqual(yield* service.forceRefresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
    }).pipe(Effect.provide(ModelManifest.layerBundled)),
  );
});
