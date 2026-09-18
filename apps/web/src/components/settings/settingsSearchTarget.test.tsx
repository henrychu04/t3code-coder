// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  SettingsSearchTarget,
  SettingsSearchTargetProvider,
  scrollToSettingsTarget,
} from "./settingsSearchTarget";
let root: Root;
let container: HTMLDivElement;
const scroll = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scroll);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  scroll.mockClear();
});
it("waits for a delayed target, focuses it, and consumes the target once", async () => {
  const handled = vi.fn();
  function Page({ ready }: { ready: boolean }) {
    const [target, setTarget] = useState<string | null>("late");
    return (
      <SettingsSearchTargetProvider
        targetId={target}
        onTargetHandled={() => {
          handled();
          setTarget(null);
        }}
      >
        {ready ? <SettingsSearchTarget id="late">Ready</SettingsSearchTarget> : <p>Loading</p>}
      </SettingsSearchTargetProvider>
    );
  }
  await act(async () => root.render(<Page ready={false} />));
  expect(handled).not.toHaveBeenCalled();
  await act(async () => root.render(<Page ready />));
  expect(document.activeElement?.id).toBe("late");
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(handled).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Page ready />));
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("honors reduced motion and scrolls a section heading while focusing its section", () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  container.innerHTML =
    '<section id="section"><h2 data-settings-scroll-target>Heading</h2></section>';
  expect(scrollToSettingsTarget("absent")).toBe(false);
  expect(scrollToSettingsTarget("section")).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
  expect(document.activeElement?.id).toBe("section");
  expect(
    container.querySelector("section")?.classList.contains("settings-search-target-pulse"),
  ).toBe(false);
});
