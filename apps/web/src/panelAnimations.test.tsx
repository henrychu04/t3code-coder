// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  usePanelPresence,
  usePanelAnimationSettings,
  PanelAnimationSuppressionProvider,
} from "./panelAnimations";
const state = vi.hoisted(() => ({ reduced: false, duration: 200 }));
vi.mock("./hooks/useMediaQuery", () => ({ useMediaQuery: () => state.reduced }));
vi.mock("./hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { panelAnimationDurationMs: number }) => unknown) =>
    select({ panelAnimationDurationMs: state.duration }),
}));
let root: Root;
let host: HTMLDivElement;
function Panel({ open, scope }: { open: boolean; scope: string }) {
  const { active, durationMs } = usePanelAnimationSettings();
  const panel = usePanelPresence(open, open ? scope : null, active, scope, durationMs);
  return <output>{panel.present ? panel.value : "absent"}</output>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.reduced = false;
  state.duration = 200;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(open: boolean, scope = "first", suppressed = false) {
  await act(async () =>
    root.render(
      <PanelAnimationSuppressionProvider value={suppressed}>
        <Panel open={open} scope={scope} />
      </PanelAnimationSuppressionProvider>,
    ),
  );
}
it("retains closing content only for its own thread and cancels a close on reopening", async () => {
  await render(true);
  await render(false);
  expect(host.textContent).toBe("first");
  await render(true);
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  expect(host.textContent).toBe("first");
  await render(false, "other");
  expect(host.textContent).toBe("absent");
});
it.each(["reduced", "disabled", "navigation"])(
  "closes immediately with %s motion",
  async (reason) => {
    state.reduced = reason === "reduced";
    state.duration = reason === "disabled" ? 0 : 200;
    await render(true, "first", reason === "navigation");
    await render(false, "first", reason === "navigation");
    expect(host.textContent).toBe("absent");
  },
);

it("retains closing content for the configured duration, then releases it", async () => {
  await render(true);
  await render(false);
  await act(async () => {
    vi.advanceTimersByTime(199);
  });
  expect(host.textContent).toBe("first");
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(host.textContent).toBe("absent");
});

it("does not resurrect closed content after leaving and returning to its thread", async () => {
  await render(true, "a");
  await render(false, "a");
  expect(host.textContent).toBe("a");
  await render(false, "b");
  await render(false, "a");
  expect(host.textContent).toBe("absent");
  await render(true, "a");
  expect(host.textContent).toBe("a");
});
