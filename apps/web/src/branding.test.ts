import { describe, expect, it } from "vite-plus/test";
import {
  APP_BASE_NAME,
  APP_DISPLAY_NAME,
  HOSTED_APP_CHANNEL,
  HOSTED_APP_CHANNEL_LABEL,
} from "./branding";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

describe("branding", () => {
  it("uses fixed Coder-only branding without hosted channel metadata", () => {
    expect(APP_BASE_NAME).toBe("T3 Coder");
    expect(APP_DISPLAY_NAME).toContain("T3 Coder");
    expect(HOSTED_APP_CHANNEL).toBeNull();
    expect(HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("T3 Code (Alpha)");
  });
});
