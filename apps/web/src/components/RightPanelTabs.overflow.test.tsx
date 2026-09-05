// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RightPanelTabs } from "./RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";

it("updates scroll controls when a terminal rename changes content width without a resize", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const surfaces: RightPanelSurface[] = [
    {
      id: "terminal:one",
      kind: "terminal",
      resourceId: "one",
      terminalIds: ["one"],
      activeTerminalId: "one",
    },
  ];
  const noop = () => {};
  const render = (label: string) =>
    act(() =>
      root.render(
        <RightPanelTabs
          mode="sheet"
          surfaces={surfaces}
          activeSurfaceId={null}
          pendingSurfaceIds={new Set()}
          terminalLabelsById={new Map([["one", label]])}
          onActivate={noop}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={noop}
          onAddPullRequest={noop}
          onAddAgents={noop}
          terminalAvailable
          diffAvailable
          filesAvailable
          pullRequestAvailable
          agentsAvailable
          liveAgentCount={0}
        >
          {null}
        </RightPanelTabs>,
      ),
    );
  try {
    await render("Shell");
    const viewport = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(viewport, "scrollWidth", {
      configurable: true,
      get: () => (viewport.textContent?.includes("A much longer terminal name") ? 250 : 80),
    });
    await render("Shell");
    expect(container.querySelector('[aria-label="Scroll tabs right"]')).toBeNull();
    await render("A much longer terminal name");
    expect(container.querySelector('[aria-label="Scroll tabs right"]')).not.toBeNull();
    await render("Shell");
    expect(container.querySelector('[aria-label="Scroll tabs right"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
