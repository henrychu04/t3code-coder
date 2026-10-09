import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

describe("deriveProviderInstanceConfigMap", () => {
  it("hydrates Codex and Claude from legacy provider settings", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

    expect(Object.keys(instances)).toEqual(["codex", "claudeAgent"]);
    expect(instances[CODEX_INSTANCE_ID]).toEqual({
      driver: "codex",
      config: DEFAULT_SERVER_SETTINGS.providers.codex,
    });
    expect(instances[CLAUDE_INSTANCE_ID]).toEqual({
      driver: "claudeAgent",
      config: DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
    });
  });

  it("keeps an explicit default Codex instance instead of the legacy mirror", () => {
    const explicitCodex = {
      driver: ProviderDriverKind.make("codex"),
      displayName: "Work Codex",
      config: { binaryPath: "/opt/codex/bin/codex" },
    };
    const instances = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [CODEX_INSTANCE_ID]: explicitCodex,
      },
    });

    expect(instances[CODEX_INSTANCE_ID]).toEqual(explicitCodex);
    expect(instances[CLAUDE_INSTANCE_ID]?.driver).toBe("claudeAgent");
  });
});
