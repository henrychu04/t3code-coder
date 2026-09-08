// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CodeFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";

const mocks = vi.hoisted(() => ({ preload: vi.fn(), create: vi.fn() }));
vi.mock("@pierre/diffs/ssr", () => ({ preloadPatchFile: mocks.preload }));
vi.mock("~/terminal/ghostty/surface", () => ({ GhosttyTerminalSurface: { create: mocks.create } }));
vi.mock("../ComposerPromptEditor", () => ({ ComposerPromptEditor: () => null }));
vi.mock("../ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ theme: "system", resolvedTheme: "dark" }),
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
  mocks.preload.mockReset();
  mocks.create.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("handles a failed diff render and retries successfully on remount", async () => {
  mocks.preload.mockRejectedValueOnce(new Error("renderer unavailable"));
  await act(async () => root.render(<CodeFontPreview />));
  expect(host.textContent).toContain("Code preview unavailable");
  await act(async () => root.render(null));
  mocks.preload.mockResolvedValueOnce([{ prerenderedHTML: "<span>Preview restored</span>" }]);
  await act(async () => root.render(<CodeFontPreview />));
  expect(mocks.preload).toHaveBeenCalledTimes(2);
  const preview = [...host.querySelectorAll("div")].find((element) => element.shadowRoot);
  expect(preview?.shadowRoot?.textContent).toContain("Preview restored");
});

it("handles terminal startup rejection with a visible fallback", async () => {
  mocks.create.mockRejectedValueOnce(new Error("WASM unavailable"));
  await act(async () => root.render(<TerminalFontPreview family="" size={14} />));
  expect(host.textContent).toContain("Terminal preview unavailable");
});
