import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { redactServerSettingsForClient } from "./serverSettings.ts";

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
