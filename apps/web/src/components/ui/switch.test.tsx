// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Switch } from "./switch";

it("exposes checked state and restores it after a mixed selection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const [checked, mixed, expected] of [
      [false, false, "false"],
      [true, false, "true"],
      [true, true, "mixed"],
      [true, false, "true"],
    ] as const) {
      await act(async () => root.render(<Switch checked={checked} mixed={mixed} />));
      expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(expected);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
