import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TextGenerationModelSettings } from "./TextGenerationModelSettings";

const CODEX = ProviderDriverKind.make("codex");

function codexProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX,
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.148.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              options: [{ id: "low", label: "Low", isDefault: true }],
              currentValue: "low",
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

describe("text generation model settings", () => {
  it("shows the resolved workspace model used for generated names", () => {
    const markup = renderToStaticMarkup(
      <TextGenerationModelSettings
        settings={{
          ...DEFAULT_UNIFIED_SETTINGS,
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
        }}
        providers={[codexProvider()]}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain("Generated names");
    expect(markup).toContain("Used for new thread titles and initial branch names.");
    expect(markup).toContain('aria-label="Thread title model"');
    expect(markup).toContain("GPT-5.6 Sol");
    expect(markup).toContain("Low");
    expect(markup).toContain('aria-label="Reset text generation model to default"');
  });
});
