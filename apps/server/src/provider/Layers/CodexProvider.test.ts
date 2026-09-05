import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CodexIntegrationPolicyError } from "./CodexIntegrationPolicy.ts";
import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("prefers a current Codex model exposed under its -codex alias", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "gpt-5.6-sol-codex",
      name: "GPT-5.6-Sol",
      isCustom: false,
      capabilities: null,
    },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol-codex");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.layer(NodeServices.layer)("Codex provider availability", (it) => {
  it.effect("publishes native quota windows with the provider snapshot", () =>
    Effect.gen(function* () {
      const provider = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.succeed({
          account: {
            account: { type: "chatgpt", email: "dev@example.test", planType: "pro" },
            requiresOpenaiAuth: true,
          },
          version: "1.0",
          models: [],
          skills: [],
          rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } },
        }),
      );
      assert.equal(provider.status, "ready");
      assert.deepEqual(provider.usageLimits?.windows, [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 42,
          windowDurationMins: 300,
        },
      ]);
    }),
  );
  it.effect("does not turn a missing quota reading into zero usage or failed authentication", () =>
    Effect.gen(function* () {
      const provider = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.succeed({
          account: {
            account: { type: "chatgpt", email: "dev@example.test", planType: "pro" },
            requiresOpenaiAuth: true,
          },
          version: "1.0",
          models: [],
          skills: [],
        }),
      );
      assert.equal(provider.status, "ready");
      assert.equal(provider.usageLimits?.unavailable?.reason, "probeFailed");
    }),
  );
  it.effect("reports API-key subscription windows as unsupported", () =>
    Effect.gen(function* () {
      const provider = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.succeed({
          account: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
          version: "1.0",
          models: [],
          skills: [],
        }),
      );
      assert.equal(provider.usageLimits?.unavailable?.reason, "unsupported");
    }),
  );
  it.effect("reports a missing Codex binary as provider-unavailable", () =>
    Effect.gen(function* () {
      const provider = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.fail(
          new CodexIntegrationPolicyError("Codex MCP policy discovery failed.", {
            unavailable: true,
          }),
        ),
      );

      assert.equal(provider.installed, false);
      assert.equal(provider.status, "error");
      assert.equal(provider.message, "Codex CLI (`codex`) was not found on PATH.");
    }),
  );
});
