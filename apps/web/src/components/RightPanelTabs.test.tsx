import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

const sharedProps = {
  surfaces: [],
  activeSurfaceId: null,
  pendingSurfaceIds: new Set<string>(),
  terminalLabelsById: new Map<string, string>(),
  onActivate: () => {},
  onCloseSurface: () => {},
  onCloseOtherSurfaces: () => {},
  onCloseSurfacesToRight: () => {},
  onCloseAllSurfaces: () => {},
  onAddTerminal: () => {},
  onAddDiff: () => {},
  onAddFiles: () => {},
  onAddAgents: () => {},
  terminalAvailable: true,
  diffAvailable: true,
  filesAvailable: true,
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
    expect(markup).toContain("pr-28");
  });

  it("reserves inline titlebar controls only when they are overlaid", () => {
    const sheetMarkup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} mode="sheet" layoutControls={<span>Controls</span>} />,
    );

    expect(sheetMarkup).toContain("pr-2");
    expect(sheetMarkup).not.toContain("pr-28");
  });

  it("does not render a resize handle when maximized or in a sheet", () => {
    const maximizedMarkup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} mode="inline" maximized />,
    );
    const sheetMarkup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="sheet" />);

    expect(maximizedMarkup).not.toContain('aria-label="Resize right panel"');
    expect(sheetMarkup).not.toContain('aria-label="Resize right panel"');
  });

  it("explains why Files is disabled before a thread starts", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} filesAvailable={false} mode="inline" />,
    );

    expect(markup).toContain("Available after the thread starts.");
  });
});
