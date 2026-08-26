import { describe, expect, it } from "vite-plus/test";

import {
  resolveAnchoredFileLineScrollTop,
  resolveVisibleFileLineAnchor,
} from "./fileLineReveal";

describe("anchored file line reveal", () => {
  it("keeps the same line offset after virtualized heights change", () => {
    expect(
      resolveAnchoredFileLineScrollTop({
        scrollHeight: 410_000,
        viewportHeight: 700,
        fileTop: 0,
        lineTop: 408_950,
        viewportOffset: 50,
      }),
    ).toBe(408_900);
  });

  it("clamps anchors near the end of the file", () => {
    expect(
      resolveAnchoredFileLineScrollTop({
        scrollHeight: 410_000,
        viewportHeight: 700,
        fileTop: 0,
        lineTop: 409_990,
        viewportOffset: 10,
      }),
    ).toBe(409_300);
  });
});

describe("visible file line anchor", () => {
  it("chooses the first fully visible rendered line", () => {
    expect(
      resolveVisibleFileLineAnchor({
        viewportTop: 100,
        viewportBottom: 300,
        lines: [
          { lineNumber: 40, top: 80, bottom: 120 },
          { lineNumber: 41, top: 120, bottom: 160 },
          { lineNumber: 42, top: 160, bottom: 200 },
        ],
      }),
    ).toEqual({ lineNumber: 41, viewportOffset: 20 });
  });

  it("allows subpixel rounding at the viewport edge", () => {
    expect(
      resolveVisibleFileLineAnchor({
        viewportTop: 100,
        viewportBottom: 300,
        lines: [{ lineNumber: 41, top: 99.75, bottom: 140 }],
      }),
    ).toEqual({ lineNumber: 41, viewportOffset: -0.25 });
  });

  it("falls back to an intersecting line when none fits fully", () => {
    expect(
      resolveVisibleFileLineAnchor({
        viewportTop: 100,
        viewportBottom: 300,
        lines: [{ lineNumber: 41, top: 80, bottom: 320 }],
      }),
    ).toEqual({ lineNumber: 41, viewportOffset: -20 });
  });

  it("returns no anchor when no rendered line intersects the viewport", () => {
    expect(
      resolveVisibleFileLineAnchor({
        viewportTop: 100,
        viewportBottom: 300,
        lines: [
          { lineNumber: 40, top: 20, bottom: 80 },
          { lineNumber: 41, top: 320, bottom: 360 },
        ],
      }),
    ).toBeUndefined();
  });
});
