import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderInstanceId,
  providerInstanceFallbackLabel,
  slugifyProviderInstanceLabel,
  validateProviderInstanceId,
} from "./WorkspaceProviderSettings.logic";

describe("workspace provider settings", () => {
  it("derives the same driver-prefixed ids as upstream", () => {
    expect(slugifyProviderInstanceLabel("  Work Account  ")).toBe("work_account");
    expect(deriveProviderInstanceId(ProviderDriverKind.make("codex"), "Work Account")).toBe(
      "codex_work_account",
    );
  });

  it("validates ids against the provider-instance contract", () => {
    const reserved = new Set(["codex", "claudeAgent", "codex_work"]);
    expect(validateProviderInstanceId("", reserved)).toBe("Instance ID is required.");
    expect(validateProviderInstanceId("1-work", reserved)).toContain("must start with a letter");
    expect(validateProviderInstanceId("codex_work", reserved)).toContain("already exists");
    expect(validateProviderInstanceId("claude_personal", reserved)).toBeNull();
  });

  it("produces a readable fallback label", () => {
    expect(providerInstanceFallbackLabel("claude_personalAccount")).toBe("Claude Personal Account");
  });
});
