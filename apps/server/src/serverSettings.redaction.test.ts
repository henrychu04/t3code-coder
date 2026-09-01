import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  redactServerSettingsForClient,
  restoreRedactedProviderEnvironmentValues,
} from "./serverSettings.ts";

describe("redactServerSettingsForClient", () => {
  it("blanks sensitive provider environment values", () => {
    const instanceId = ProviderInstanceId.make("claude-workspace");
    const redacted = redactServerSettingsForClient({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claude"),
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "workspace-secret", sensitive: true },
            {
              name: "ANTHROPIC_BASE_URL",
              value: "https://example.test",
              sensitive: false,
              valueRedacted: true,
            },
          ],
        },
      },
    });

    expect(redacted.providerInstances[instanceId]?.environment).toEqual([
      {
        name: "ANTHROPIC_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
      {
        name: "ANTHROPIC_BASE_URL",
        value: "https://example.test",
        sensitive: false,
      },
    ]);
  });
});

describe("restoreRedactedProviderEnvironmentValues", () => {
  it("preserves workspace secrets when an instance map is written back", () => {
    const instanceId = ProviderInstanceId.make("codex-workspace");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [
            { name: "OPENAI_API_KEY", value: "workspace-secret", sensitive: true },
            { name: "OPENAI_BASE_URL", value: "https://old.test", sensitive: false },
          ],
        },
      },
    };

    const restored = restoreRedactedProviderEnvironmentValues(current, {
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work",
          environment: [
            { name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
            { name: "OPENAI_BASE_URL", value: "https://new.test", sensitive: false },
          ],
        },
      },
    });

    expect(restored.providerInstances?.[instanceId]?.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "workspace-secret", sensitive: true },
      { name: "OPENAI_BASE_URL", value: "https://new.test", sensitive: false },
    ]);
  });
});
