// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { BundledThemeSettings } from "./BundledThemeSettings";
import { RestoreClientSettings } from "./RestoreSettings";
import { THEME_HALVES_STORAGE_KEY, parseThemeHalves, resolveThemeHalf } from "../../themePalette";
import { readThemePreference, readAppearanceModePreference } from "../../hooks/useTheme";
const mocks = vi.hoisted(() => ({ save: vi.fn(), confirm: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" }),
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" }),
  saveClientSettings: mocks.save,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.confirm.mockReset().mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
function effective(mode: "light" | "dark") {
  return resolveThemeHalf(
    readThemePreference(),
    parseThemeHalves(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY)),
    mode,
  );
}
it("shows the stock theme as selected on a fresh browser", async () => {
  await act(async () => root.render(<BundledThemeSettings />));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "t3code:theme" })));
  expect(
    host.querySelector('button[aria-label="Use T3 Code dark mode"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    host.querySelector('button[aria-label="Use T3 Code light mode"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
});
it.each([false, true])(
  "assigns the stock dark half while preserving the opposite half (mixed: %s)",
  async (mixed) => {
    window.localStorage.setItem("t3code:theme", "grove");
    if (mixed)
      window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify({ light: "ocean" }));
    await act(async () => root.render(<BundledThemeSettings />));
    await act(async () =>
      window.dispatchEvent(new StorageEvent("storage", { key: "t3code:theme" })),
    );
    await click("Use T3 Code dark mode");
    expect(effective("light")).toBe(mixed ? "ocean" : "grove");
    expect(effective("dark")).not.toBe("grove");
    expect(
      host
        .querySelector('button[aria-label="Use T3 Code dark mode"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  },
);
it("chooses the whole stock theme without writing the card's display ID", async () => {
  window.localStorage.setItem("t3code:theme", "grove");
  window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify({ dark: "ocean" }));
  await act(async () => root.render(<BundledThemeSettings />));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "t3code:theme" })));
  await click("Use T3 Code theme");
  expect(["system", "light", "dark"]).toContain(window.localStorage.getItem("t3code:theme"));
  expect(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY)).toBeNull();
});
it("rolls back the live theme and mix if restoring appearance mode fails", async () => {
  window.localStorage.setItem("t3code:theme", "grove");
  // Simulate another settings surface changing the palette while confirmation is open.
  mocks.confirm.mockImplementation(async () => {
    window.localStorage.setItem("t3code:theme", "ocean");
    window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify({ light: "iris" }));
    return true;
  });
  window.localStorage.setItem("t3code:theme-appearance-mode", "dark");
  const storage = window.localStorage;
  const original = storage.setItem.bind(storage);
  vi.spyOn(window, "localStorage", "get").mockReturnValue(
    new Proxy(storage, {
      get(target, prop) {
        if (prop !== "setItem") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (key: string, value: string) => {
          if (key === "t3code:theme-appearance-mode" && value === "system")
            throw new Error("write blocked");
          original(key, value);
        };
      },
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(<RestoreClientSettings />));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "t3code:theme" })));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(readThemePreference()).toBe("ocean");
  expect(effective("light")).toBe("iris");
  expect(readAppearanceModePreference(readThemePreference())).not.toBe("system");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not restore theme");
});
