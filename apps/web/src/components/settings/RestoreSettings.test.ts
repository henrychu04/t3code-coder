import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { changedSettings, CLIENT_RESET_LABELS, WORKSPACE_RESET_LABELS } from "./RestoreSettings";
describe("scoped settings resets", () => {
  it("includes notifications and diff colors in browser resets", () => {
    expect(
      changedSettings(
        {
          ...DEFAULT_CLIENT_SETTINGS,
          notificationMode: "notifications-and-sound",
          inAppNotificationsEnabled: true,
          diffColorScheme: "blue-orange",
        },
        DEFAULT_CLIENT_SETTINGS,
        CLIENT_RESET_LABELS,
      ),
    ).toEqual(["notificationMode", "inAppNotificationsEnabled", "diffColorScheme"]);
  });
  it("lists only changed supported browser preferences", () => {
    expect(
      changedSettings(
        { ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split", showSkillsInSlashMenu: false },
        DEFAULT_CLIENT_SETTINGS,
        CLIENT_RESET_LABELS,
      ),
    ).toEqual(["diffLayout", "showSkillsInSlashMenu"]);
  });
  it("does not include provider configuration or unrelated settings in workspace resets", () => {
    expect(Object.keys(WORKSPACE_RESET_LABELS)).not.toContain("providers");
    expect(Object.keys(WORKSPACE_RESET_LABELS)).not.toContain("providerInstances");
    expect(
      changedSettings(DEFAULT_SERVER_SETTINGS, DEFAULT_SERVER_SETTINGS, WORKSPACE_RESET_LABELS),
    ).toEqual([]);
  });
});
