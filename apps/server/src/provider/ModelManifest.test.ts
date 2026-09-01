import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { BUNDLED_MODEL_MANIFEST, classifyModels, isLegacyModel } from "./ModelManifest.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

describe("bundled model manifest", () => {
  it("matches upstream's current Codex classification", () => {
    assert.deepStrictEqual(
      [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-5.6-sol-codex",
        "gpt-5.4",
        "gpt-5.4-codex",
      ].map((model) => [model, isLegacyModel(BUNDLED_MODEL_MANIFEST, CODEX, model)]),
      [
        ["gpt-5.6-luna", false],
        ["gpt-5.6-terra", false],
        ["gpt-5.6-sol", false],
        ["gpt-5.6-sol-codex", false],
        ["gpt-5.4", true],
        ["gpt-5.4-codex", true],
      ],
    );
  });

  it("matches upstream's current Claude classification", () => {
    assert.deepStrictEqual(
      [
        "claude-fable-5",
        "claude-fable-5-codex",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-8",
      ].map((model) => [model, isLegacyModel(BUNDLED_MODEL_MANIFEST, CLAUDE, model)]),
      [
        ["claude-fable-5", false],
        ["claude-fable-5-codex", true],
        ["claude-opus-5", false],
        ["claude-sonnet-5", false],
        ["claude-opus-4-8", true],
      ],
    );
  });

  it("flags old built-ins, clears stale flags, and preserves custom models", () => {
    const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
      slug: "gpt-test",
      name: "GPT Test",
      isCustom: false,
      capabilities: null,
      ...overrides,
    });

    assert.deepStrictEqual(
      classifyModels(
        [
          model({ slug: "gpt-5.6-sol" }),
          model({ slug: "gpt-5.6-luna", isLegacy: true }),
          model({ slug: "gpt-5.4" }),
          model({ slug: "my-own-model", isCustom: true }),
        ],
        BUNDLED_MODEL_MANIFEST,
        CODEX,
      ).map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["gpt-5.6-sol", false],
        ["gpt-5.6-luna", false],
        ["gpt-5.4", true],
        ["my-own-model", false],
      ],
    );
  });
});
