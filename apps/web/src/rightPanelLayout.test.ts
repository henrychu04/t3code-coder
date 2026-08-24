import { describe, expect, it } from "vite-plus/test";

import {
  resolveRightPanelWidths,
  RIGHT_PANEL_DEFAULT_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_SIBLING_MIN_WIDTH,
} from "./rightPanelLayout";

describe("right panel layout", () => {
  it("preserves the existing default width proportion", () => {
    expect(resolveRightPanelWidths(1200)).toEqual({
      defaultWidth: 576,
      maxWidth: 840,
    });
  });

  it("caps the default width without capping user expansion on wide viewports", () => {
    expect(resolveRightPanelWidths(2400)).toEqual({
      defaultWidth: RIGHT_PANEL_DEFAULT_MAX_WIDTH,
      maxWidth: 1680,
    });
  });

  it("allows substantial expansion on a 4K-width workspace", () => {
    expect(resolveRightPanelWidths(3840, 3584)).toEqual({
      defaultWidth: RIGHT_PANEL_DEFAULT_MAX_WIDTH,
      maxWidth: 2688,
    });
  });

  it("keeps the width range valid on narrow viewports", () => {
    expect(resolveRightPanelWidths(300)).toEqual({
      defaultWidth: RIGHT_PANEL_MIN_WIDTH,
      maxWidth: RIGHT_PANEL_MIN_WIDTH,
    });
  });

  it("reserves usable space for the sibling chat column", () => {
    const containerWidth = 800;

    expect(resolveRightPanelWidths(1200, containerWidth)).toEqual({
      defaultWidth: Math.floor(containerWidth * 0.48),
      maxWidth: containerWidth - RIGHT_PANEL_SIBLING_MIN_WIDTH,
    });
  });

  it("leaves room to grow after measuring the workspace container", () => {
    const widths = resolveRightPanelWidths(1200, 800);

    expect(widths.defaultWidth).toBeLessThan(widths.maxWidth);
  });

  it("keeps the panel minimum when the row cannot fit both column minimums", () => {
    expect(resolveRightPanelWidths(1200, 600)).toEqual({
      defaultWidth: RIGHT_PANEL_MIN_WIDTH,
      maxWidth: RIGHT_PANEL_MIN_WIDTH,
    });
  });
});
