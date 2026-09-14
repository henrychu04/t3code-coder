import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { adjacentModelPickerProvider } from "./ModelPickerContent";
function entry(status: ServerProvider["status"], driver = "codex") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_${status}`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "codex");
  const claude = entry("ready", "claudeAgent");
  const unavailable = entry("error");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("wraps through favorites and ready instances, skipping unavailable providers", () => {
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: codex.instanceId, direction: 1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: -1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: claude.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
  });

  it("keeps thread locks and the selected unavailable catalog", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        disabledInstanceIds: new Set([claude.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectableUnavailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
  });

  it("handles an empty catalog and a removed selection in either direction", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        entries: [],
        selectedInstanceId: codex.instanceId,
        direction: -1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: -1,
      }),
    ).toBe(claude.instanceId);
  });
});
