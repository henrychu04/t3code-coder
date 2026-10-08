import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  getModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  installed?: boolean;
  status?: ServerProvider["status"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId === "claudeAgent" || input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    enabled: true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("preserves server-provided legacy model metadata", () => {
    const baseProvider = provider({
      instanceId: "claudeAgent",
      models: ["claude-opus-4-8"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [{ ...baseProvider.models[0]!, isLegacy: true }],
      },
    ];
    const stock = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settingsWithProviderInstances(), stock)[0]?.isLegacy).toBe(
      true,
    );
  });

  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug on the workspace provider", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        {
          ...settingsWithProviderInstances(),
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
        },
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: ["claude-opus-4-8"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["opus"] },
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-opus-4-8",
      "opus",
    ]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "opus",
      ),
    ).toBe("opus");
  });

  it("offers only the built-in Codex and Claude provider instances", () => {
    const providers = [
      provider({ instanceId: "claudeAgent", models: ["claude-sonnet-4-6"] }),
      provider({ instanceId: "claude_openrouter", models: ["claude-sonnet-4-6"] }),
      provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok", models: ["grok"] }),
      provider({ instanceId: "codex", models: ["gpt-5.4"] }),
    ];

    expect([
      ...getModelOptionsByInstance(settingsWithProviderInstances(), providers).keys(),
    ]).toEqual([ProviderInstanceId.make("claudeAgent"), ProviderInstanceId.make("codex")]);
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("drops server-reported custom rows that are no longer in settings", () => {
    const baseProvider = provider({
      instanceId: "claude_openrouter",
      models: ["claude-sonnet-4-6"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [
          ...baseProvider.models,
          { slug: "removed/custom", name: "removed/custom", isCustom: true, capabilities: {} },
        ],
      },
    ];
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toEqual(["claude-sonnet-4-6", "openai/gpt-5.5"]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back from an unsupported provider instance in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it("replaces a missing Codex text-generation instance with Claude", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it("replaces an unavailable Codex text-generation instance with ready Claude", () => {
    const providers = [
      provider({
        instanceId: "codex",
        installed: false,
        status: "error",
        models: [],
      }),
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });
});

it("keeps configured custom models visible despite hidden built-in preferences", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const snapshot = provider({ instanceId, models: ["gpt-5.4"] });
  const settings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providers: {
      ...DEFAULT_UNIFIED_SETTINGS.providers,
      codex: {
        ...DEFAULT_UNIFIED_SETTINGS.providers.codex,
        customModels: [{ slug: "custom", name: "Custom" }],
      },
    },
    providerModelPreferences: {
      [instanceId]: { hiddenModels: ["custom", "gpt-5.4"], modelOrder: [] },
    },
  };
  expect(
    getAppModelOptionsForInstance(settings, deriveProviderInstanceEntries([snapshot])[0]!),
  ).toEqual([{ slug: "custom", name: "Custom", isCustom: true }]);
});

it("preserves a custom settings selection and validates its dispatch options", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const selection = { instanceId, model: "custom", options: [{ id: "effort", value: "low" }] };
  const settings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerationModelSelection: selection,
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("codex"),
        config: { customModels: ["custom"] },
      },
    },
  };
  const snapshot = provider({ instanceId, models: ["gpt-5.4"] });
  const providers: ReadonlyArray<ServerProvider> = [
    {
      ...snapshot,
      models: [
        ...snapshot.models,
        {
          slug: "custom",
          name: "Custom",
          isCustom: true,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            ],
            supportedRuntimeModes: ["approval-required", "full-access"],
          },
        },
      ],
    },
  ];
  expect(resolveAppModelSelectionState(settings, providers)).toEqual(selection);
});
