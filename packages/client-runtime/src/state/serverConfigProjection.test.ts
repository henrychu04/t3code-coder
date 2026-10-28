import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });
});

it("applies published-theme changes and removals without disturbing other config", () => {
  const config = {
    providers: [],
    environment: { capabilities: { environmentThemes: true } },
  } as unknown as ServerConfig;
  const snapshot: ServerConfigStreamEvent = { version: 1, type: "snapshot", config };
  const initial = applyServerConfigProjection(Option.none(), snapshot);
  const themes = [
    { id: "night", name: "Night", appearance: "dark" as const, canvas: "#111", accent: "#f80" },
  ];
  const updated = applyServerConfigProjection(initial, {
    version: 1,
    type: "environmentThemesUpdated",
    payload: { themes },
  });
  expect(Option.getOrThrow(updated).config).toEqual({ ...config, environmentThemes: themes });
  const removed = applyServerConfigProjection(updated, {
    version: 1,
    type: "environmentThemesUpdated",
    payload: { themes: [] },
  });
  expect(Option.getOrThrow(removed).config.environmentThemes).toBeUndefined();
  expect(
    applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "environmentThemesUpdated",
      payload: { themes },
    }),
  ).toEqual(Option.none());
});

it("replaces the entire provider array and carries themes across snapshots", () => {
  const config = {
    providers: [],
    environment: { capabilities: { environmentThemes: true } },
  } as unknown as ServerConfig;
  const themes = [
    { id: "night", name: "Night", appearance: "dark" as const, canvas: "#111", accent: "#f80" },
  ];
  const snapshot = { version: 1 as const, type: "snapshot" as const, config };
  const initial = applyServerConfigProjection(Option.none(), snapshot);
  const themed = applyServerConfigProjection(initial, {
    version: 1,
    type: "environmentThemesUpdated",
    payload: { themes },
  });
  expect(
    Option.getOrThrow(applyServerConfigProjection(themed, snapshot)).config.environmentThemes,
  ).toEqual(themes);
  const providers = [{ instanceId: "codex" }] as unknown as ServerConfig["providers"];
  const updated = applyServerConfigProjection(themed, {
    version: 1,
    type: "providerStatuses",
    payload: { providers },
  });
  expect(Option.getOrThrow(updated).config.providers).toEqual(providers);
  const cleared = applyServerConfigProjection(updated, {
    version: 1,
    type: "providerStatuses",
    payload: { providers: [] },
  });
  expect(Option.getOrThrow(cleared).config.providers).toEqual([]);
});
