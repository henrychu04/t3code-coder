import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldResetTextGenerationSelectionOnDisable } from "./WorkspaceProviderSettings.logic";
import { resolveSettingsWorkspaceId } from "./WorkspaceSettingsTarget";

describe("workspace provider settings", () => {
  it("keeps an explicit selection, then falls back to the active or first workspace", () => {
    const resolve = (selectedWorkspaceId: string | null, activeWorkspaceId: string | null) =>
      resolveSettingsWorkspaceId({
        workspaceIds: ["workspace-a", "workspace-b"],
        selectedWorkspaceId,
        activeWorkspaceId,
      });

    expect(resolve("workspace-b", "workspace-a")).toBe("workspace-b");
    expect(resolve("disconnected", "workspace-b")).toBe("workspace-b");
    expect(resolve("disconnected", "disconnected")).toBe("workspace-a");
    expect(
      resolveSettingsWorkspaceId({
        workspaceIds: [],
        selectedWorkspaceId: "workspace-a",
        activeWorkspaceId: "workspace-b",
      }),
    ).toBeNull();
  });

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
