// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export type TimelineScrollRestoration =
  | { readonly kind: "following-end" }
  | { readonly kind: "row"; readonly rowId: string; readonly viewOffset: number };

export interface TimelineScrollRestorationState {
  readonly data: readonly { readonly id: string }[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface TimelineScrollRestorationViewport {
  readonly scroll?: number;
  readonly viewOffsetForRow?: (rowId: string) => number | undefined;
}

export function captureTimelineScrollRestoration(
  state: TimelineScrollRestorationState | undefined,
  isAtEnd: boolean,
  viewport?: TimelineScrollRestorationViewport,
): TimelineScrollRestoration | undefined {
  if (isAtEnd) {
    return { kind: "following-end" };
  }
  const scroll = viewport?.scroll ?? state?.scroll;
  if (
    !state ||
    typeof scroll !== "number" ||
    !Number.isFinite(scroll) ||
    !Number.isFinite(state.scrollLength)
  ) {
    return undefined;
  }

  const viewportBottom = scroll + state.scrollLength;
  for (let index = 0; index < state.data.length; index += 1) {
    const row = state.data[index];
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
      !row ||
      typeof top !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(top) ||
      !Number.isFinite(height)
    ) {
      continue;
    }

    const bottom = top + Math.max(1, height);
    if (bottom > scroll && top < viewportBottom) {
      const measuredViewOffset = viewport?.viewOffsetForRow?.(row.id);
      return {
        kind: "row",
        rowId: row.id,
        viewOffset:
          typeof measuredViewOffset === "number" && Number.isFinite(measuredViewOffset)
            ? measuredViewOffset
            : top - scroll,
      };
    }
  }

  return undefined;
}

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
