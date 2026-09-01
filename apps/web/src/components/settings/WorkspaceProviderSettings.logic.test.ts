import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldResetTextGenerationSelectionOnDisable } from "./WorkspaceProviderSettings.logic";

describe("workspace provider settings", () => {
  it("resets text generation only when its selected provider is disabled", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex_work");
    const shouldReset = (overrides: Partial<{ instanceId: string; nextEnabled: boolean }>) =>
      shouldResetTextGenerationSelectionOnDisable({
        instanceId: ProviderInstanceId.make(overrides.instanceId ?? "codex_work"),
        selectedInstanceId,
        wasEnabled: true,
        nextEnabled: overrides.nextEnabled,
      });

    expect(shouldReset({ nextEnabled: false })).toBe(true);
    expect(shouldReset({ instanceId: "claudeAgent", nextEnabled: false })).toBe(false);
    expect(shouldReset({ nextEnabled: true })).toBe(false);
  });
});
