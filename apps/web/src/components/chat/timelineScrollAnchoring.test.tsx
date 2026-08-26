import { describe, expect, it, vi } from "vite-plus/test";
import {
  captureTimelineScrollRestoration,
  getAnchoredTurnMetrics,
  getRowBottom,
  keepTimelineEndVisibleAfterOverlayGrowth,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("stores bottom-follow as intent instead of a stale offset", () => {
    expect(captureTimelineScrollRestoration(undefined, true)).toEqual({
      kind: "following-end",
    });
  });

  it("anchors history to the first visible row and its viewport offset", () => {
    const state = {
      data: [{ id: "first" }, { id: "visible" }, { id: "last" }],
      scroll: 150,
      scrollLength: 200,
      positionAtIndex: (index: number) => [0, 120, 300][index],
      sizeAtIndex: (index: number) => [100, 100, 100][index],
    };

    expect(captureTimelineScrollRestoration(state, false)).toEqual({
      kind: "row",
      rowId: "visible",
      viewOffset: -30,
    });
  });

  it("uses the viewport scroll offset when LegendList state trails the DOM", () => {
    const state = {
      data: [{ id: "visible" }, { id: "next" }],
      scroll: 180,
      scrollLength: 200,
      positionAtIndex: (index: number) => [100, 320][index],
      sizeAtIndex: (index: number) => [220, 100][index],
    };

    expect(captureTimelineScrollRestoration(state, false, { scroll: 200 })).toEqual({
      kind: "row",
      rowId: "visible",
      viewOffset: -100,
    });
  });

  it("prefers the rendered row offset when list headers use different coordinates", () => {
    const state = {
      data: [{ id: "visible" }],
      scroll: 200,
      scrollLength: 300,
      positionAtIndex: () => 100,
      sizeAtIndex: () => 500,
    };

    expect(
      captureTimelineScrollRestoration(state, false, {
        scroll: 200,
        viewOffsetForRow: () => -52,
      }),
    ).toEqual({
      kind: "row",
      rowId: "visible",
      viewOffset: -52,
    });
  });

  it("skips unmeasured rows when capturing a history anchor", () => {
    const state = {
      data: [{ id: "unmeasured" }, { id: "visible" }],
      scroll: 50,
      scrollLength: 200,
      positionAtIndex: (index: number) => [Number.NaN, 80][index],
      sizeAtIndex: (index: number) => [Number.NaN, 40][index],
    };

    expect(captureTimelineScrollRestoration(state, false)).toEqual({
      kind: "row",
      rowId: "visible",
      viewOffset: 30,
    });
  });

  it("does not replace a prior anchor when no measured row is visible", () => {
    const state = {
      data: [{ id: "above" }],
      scroll: 500,
      scrollLength: 200,
      positionAtIndex: () => 0,
      sizeAtIndex: () => 100,
    };

    expect(captureTimelineScrollRestoration(state, false)).toBeUndefined();
  });

  it("keeps the live edge visible when the composer overlay grows", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: true,
    });

    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("leaves the scroll position alone while the user reads history", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: false,
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});
