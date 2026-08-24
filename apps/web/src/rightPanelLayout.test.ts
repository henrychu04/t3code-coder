import { describe, expect, it } from "vite-plus/test";

import {
  resolveRightPanelWidths,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_SIBLING_MIN_WIDTH,
} from "./rightPanelLayout";

describe("right panel layout", () => {
  it("preserves the existing default width proportion", () => {
    expect(resolveRightPanelWidths(1200)).toEqual({
      defaultWidth: 576,
      maxWidth: RIGHT_PANEL_MAX_WIDTH,
    });
  });

  it("caps the panel width on wide viewports", () => {
    expect(resolveRightPanelWidths(2400)).toEqual({
      defaultWidth: RIGHT_PANEL_MAX_WIDTH,
      maxWidth: RIGHT_PANEL_MAX_WIDTH,
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
      defaultWidth: containerWidth - RIGHT_PANEL_SIBLING_MIN_WIDTH,
      maxWidth: containerWidth - RIGHT_PANEL_SIBLING_MIN_WIDTH,
    });
  });

  it("keeps the panel minimum when the row cannot fit both column minimums", () => {
    expect(resolveRightPanelWidths(1200, 600)).toEqual({
      defaultWidth: RIGHT_PANEL_MIN_WIDTH,
      maxWidth: RIGHT_PANEL_MIN_WIDTH,
    });
  });
});
