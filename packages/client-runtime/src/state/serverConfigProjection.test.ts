import { expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { type ServerConfig, type ServerConfigStreamEvent } from "@t3tools/contracts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";
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

it("replaces the entire provider array and carries themes only for capable snapshots", () => {
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
  const downgraded = applyServerConfigProjection(themed, {
    version: 1,
    type: "snapshot",
    config: {
      ...config,
      environment: { ...config.environment, capabilities: { repositoryIdentity: true } },
    },
  });
  expect(Option.getOrThrow(downgraded).config.environmentThemes).toBeUndefined();
});
