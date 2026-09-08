// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";

const state = vi.hoisted(() => ({ hash: "", update: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: state.hash }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    fontFamilyCode: "Code Mono",
    fontFamilyTerminal: "Terminal Mono",
    fontSizeCode: 15,
    fontSizeTerminal: 18,
  }),
  useUpdateClientSettings: () => state.update,
}));
vi.mock("./SettingsFontPreviews", () => ({
  PromptFontPreview: () => null,
  CodeFontPreview: () => null,
  TerminalFontPreview: ({ family, size }: { family: string; size: number }) => (
    <output data-testid="terminal-preview">
      {family}:{size}
    </output>
  ),
}));
vi.mock("./FontFamilyPicker", () => ({
  useFontEnumeration: () => ({ status: "unavailable" }),
  discoverInstalledFonts: vi.fn(),
  FontFamilyPicker: () => null,
}));
vi.mock("../../appearanceFonts", async (original) => ({
  ...(await original<typeof import("../../appearanceFonts")>()),
  resolveDefaultFamilyLabel: () => "System default",
  isFontFamilyAvailable: (family: string) => family === "Valid Mono",
  isMonospaceFamily: (family: string) => family === "Valid Mono",
}));
import { TypographySection } from "./TypographySection";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.hash = "";
  state.update.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<TypographySection />));
}

describe("upstream typography controls", () => {
  it("switches from the shared code font to separate terminal settings and persists the mode", async () => {
    await render();
    expect(container.querySelector("#terminal-font")).toBeNull();
    expect(container.querySelector('[data-testid="terminal-preview"]')?.textContent).toBe(
      "Code Mono:15",
    );
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector("#terminal-font")).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-preview"]')?.textContent).toBe(
      "Terminal Mono:18",
    );
    expect(localStorage.getItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY)).toBe("true");
  });

  it("opens advanced settings for a search jump to the terminal font", async () => {
    state.hash = "terminal-font";
    await render();
    expect(container.querySelector("#terminal-font")).not.toBeNull();
  });

  it("resets the font family and size together", async () => {
    await render();
    await act(async () =>
      (
        container.querySelector('[aria-label="Reset monospace font to default"]') as HTMLElement
      ).click(),
    );
    expect(state.update).toHaveBeenCalledWith({
      fontFamilyCode: DEFAULT_CLIENT_SETTINGS.fontFamilyCode,
      fontSizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
    });
  });
  it("rejects unavailable fallback fonts and commits a valid family on Enter", async () => {
    await render();
    const input = container.querySelector(
      '[aria-label="Monospace font family"]',
    ) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    async function enterFamily(family: string) {
      await act(async () => {
        setValue.call(input, family);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    }
    await enterFamily("Missing font");
    expect(state.update).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await enterFamily("Valid Mono");
    expect(state.update).toHaveBeenCalledWith({ fontFamilyCode: "Valid Mono" });
  });
});
