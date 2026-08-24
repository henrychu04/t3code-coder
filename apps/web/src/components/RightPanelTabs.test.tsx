import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

const sharedProps = {
  surfaces: [],
  activeSurfaceId: null,
  terminalLabelsById: new Map<string, string>(),
  onActivate: () => {},
  onCloseSurface: () => {},
  onCloseOtherSurfaces: () => {},
  onCloseSurfacesToRight: () => {},
  onCloseAllSurfaces: () => {},
  onAddTerminal: () => {},
  onAddDiff: () => {},
  onAddAgents: () => {},
  terminalAvailable: true,
  diffAvailable: true,
  agentsAvailable: true,
  liveAgentCount: 0,
  children: null,
} as const;

describe("RightPanelTabs", () => {
  it("renders a resize handle for the inline panel", () => {
    const markup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="inline" />);

    expect(markup).toContain('aria-label="Resize right panel"');
    expect(markup).toContain('style="width:614px"');
    expect(markup).toContain("max-w-full");
  });

  it("does not render a resize handle when maximized or in a sheet", () => {
    const maximizedMarkup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} mode="inline" maximized />,
    );
    const sheetMarkup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="sheet" />);

    expect(maximizedMarkup).not.toContain('aria-label="Resize right panel"');
    expect(sheetMarkup).not.toContain('aria-label="Resize right panel"');
  });
});
