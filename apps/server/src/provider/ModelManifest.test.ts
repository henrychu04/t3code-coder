import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ModelManifest from "./ModelManifest.ts";

describe("resolveProviderCatalog", () => {
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
