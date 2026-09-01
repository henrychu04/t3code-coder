import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  PROVIDER_CLIENT_DEFINITION_BY_VALUE,
} from "./providerDriverMeta";

describe("ProviderSettingsForm helpers", () => {
  it("exposes only the two workspace providers supported by T3 Coder", () => {
    expect(
      PROVIDER_CLIENT_DEFINITIONS.map((definition) => ({
        driver: definition.value,
        label: definition.label,
      })),
    ).toEqual([
      { driver: "codex", label: "Codex" },
      { driver: "claudeAgent", label: "Claude" },
    ]);
  });

  it("derives Codex fields from the upstream schema annotations", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(definition).toBeDefined();
    expect(deriveProviderSettingsFields(definition!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("uses the same form for Claude's workspace settings", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(definition).toBeDefined();
    expect(deriveProviderSettingsFields(definition!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
    ]);
  });

  it("preserves unknown config keys while omitting an empty field", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[ProviderDriverKind.make("codex")]!;
    const binaryPath = deriveProviderSettingsFields(definition).find(
      (field) => field.key === "binaryPath",
    )!;
    expect(
      nextProviderConfigWithFieldValue({ forkOwned: 1, binaryPath: "/opt/codex" }, binaryPath, ""),
    ).toEqual({ forkOwned: 1 });
  });

  it("reads unexpected field values conservatively", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
