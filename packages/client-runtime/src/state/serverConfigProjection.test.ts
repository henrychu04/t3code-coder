import { expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { type ServerConfig, type ServerConfigStreamEvent } from "@t3tools/contracts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";
it("applies published-theme changes and removals without disturbing other config", () => {
  const config = { providers: [], environmentThemes: [] } as unknown as ServerConfig;
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
  expect(Option.getOrThrow(removed).config.environmentThemes).toEqual([]);
  expect(
    applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "environmentThemesUpdated",
      payload: { themes },
    }),
  ).toEqual(Option.none());
});
