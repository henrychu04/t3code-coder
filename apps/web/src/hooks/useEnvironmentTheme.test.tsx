// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentTheme } from "@t3tools/contracts";
import { useEnvironmentThemeSync, publishedThemeDefinitions } from "./useEnvironmentTheme";
import { useTheme, readThemeHalvesRaw } from "./useTheme";
import {
  applyThemeColorPreview,
  getDefaultThemeColors,
  getEnvironmentThemes,
  getThemeColorVariable,
  setEnvironmentThemes,
  THEME_PREVIEW_ID,
  THEME_HALVES_STORAGE_KEY,
} from "../themePalette";
const state = vi.hoisted(() => ({ themes: [] as EnvironmentTheme[] }));
vi.mock("../state/entities", () => ({ useActiveEnvironmentId: () => "workspace" }));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ serverConfig: { environmentThemes: state.themes } }),
}));
let host: HTMLDivElement;
let root: Root;
let theme: ReturnType<typeof useTheme>;
function Sync() {
  useEnvironmentThemeSync();
  theme = useTheme();
  return null;
}
const published: EnvironmentTheme = {
  id: "workspace-night",
  name: "Workspace Night",
  appearance: "dark",
  canvas: "#101020",
  accent: "#3377ff",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  state.themes = [];
  delete document.documentElement.dataset.themeId;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setEnvironmentThemes([]);
  vi.unstubAllGlobals();
});
it("filters reserved IDs and invalid colors while retaining supported variants", () => {
  const definitions = publishedThemeDefinitions([
    { ...published, id: "dark" },
    { ...published, id: "t3-iris" },
    {
      id: "bad",
      name: "Invalid",
      appearance: "dark",
      colors: { canvas: "url(https://example.com)" },
    },
    {
      ...published,
      colors: { canvas: "#121212", unknown: "#fff" },
      variants: { light: { canvas: "#fff" } },
    },
  ]);
  expect(definitions).toHaveLength(1);
  expect(definitions[0]?.variants?.light).toBeDefined();
  expect(definitions[0]?.managed).toBeUndefined();
  expect(definitions[0]?.colors).not.toHaveProperty("unknown");
});
it("repaints a selected published theme on updates without persisting its colors", async () => {
  state.themes = [published];
  await act(async () => root.render(<Sync />));
  await act(async () => {
    theme.setThemeHalf("dark", published.id);
    theme.setAppearanceMode("dark");
  });
  const variable = getThemeColorVariable("accent");
  const previous = document.documentElement.style.getPropertyValue(variable);
  state.themes = [{ ...published, accent: "#ee7733" }];
  await act(async () => root.render(<Sync />));
  expect(document.documentElement.style.getPropertyValue(variable)).not.toBe(previous);
  expect(window.localStorage.getItem("t3code:custom-themes")).toBeNull();
  expect(getEnvironmentThemes()[0]?.id).toBe(published.id);
});
it("preserves an editor preview while themes update and restores the latest palette on close", async () => {
  state.themes = [published];
  await act(async () => root.render(<Sync />));
  await act(async () => {
    theme.setThemeHalf("dark", published.id);
    theme.setAppearanceMode("dark");
  });
  applyThemeColorPreview(getDefaultThemeColors("light"), "light");
  const variable = getThemeColorVariable("accent");
  const preview = document.documentElement.style.getPropertyValue(variable);
  state.themes = [{ ...published, accent: "#dd5522" }];
  await act(async () => root.render(<Sync />));
  expect(document.documentElement.dataset.themeId).toBe(THEME_PREVIEW_ID);
  expect(document.documentElement.style.getPropertyValue(variable)).toBe(preview);
  await act(async () => theme.refreshTheme());
  expect(document.documentElement.dataset.themeId).toBe(published.id);
  expect(document.documentElement.style.getPropertyValue(variable)).not.toBe(preview);
});
it("keeps an unresolved half while editing the other half before workspace metadata arrives", async () => {
  window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify({ dark: published.id }));
  await act(async () => root.render(<Sync />));
  await act(async () => {
    theme.setThemeHalf("light", "grove");
  });
  expect(readThemeHalvesRaw()).toEqual({ light: "grove", dark: published.id });
  state.themes = [published];
  await act(async () => root.render(<Sync />));
  expect(theme.themeHalves?.dark).toBe(published.id);
});
