export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
export const RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT = 3;

export function getRestingComposerImagePreviewCounts(imageCount: number): {
  visibleCount: number;
  overflowCount: number;
} {
  const visibleCount = Math.min(imageCount, RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT);
  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
}

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseRestingComposerLayout(input: {
  isExistingThread: boolean;
  isMobileViewport: boolean;
  isFocused: boolean;
  isScrollCollapsed: boolean;
  hasExpandedChrome: boolean;
  collapseOnBlur: boolean;
}): boolean {
  // Passive draft content is deliberately absent here. Resting only clamps
  // the prompt row and overlays its actions; non-image attachment and context
  // rows keep their natural height above it while image previews move inline.
  // Banners and the tasks badge dock above the surface, so they are absent
  // too. Whether the context strip can host the relocated controls is
  // deliberately absent here: resting reclaims vertical space at every
  // desktop width, and where the strip is missing or too narrow the controls
  // simply return when the composer is focused.
  const collapsed = input.isScrollCollapsed || (input.collapseOnBlur && !input.isFocused);
  return input.isExistingThread && !input.isMobileViewport && collapsed && !input.hasExpandedChrome;
}

/** Minimum extra height between the resting and empty expanded composer. */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/** Keep enough timeline space reserved that expanding cannot cover its end. */
export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
}): number {
  return input.isResting
    ? Math.max(input.currentInset, input.overlayHeight + COMPOSER_RESTING_EXPANSION_MIN_PX)
    : input.overlayHeight;
}

export function shouldAnimateComposerRestingTransition(input: {
  hasCompletedInitialLayout: boolean;
  stateChanged: boolean;
  hasInterruptedAnimation: boolean;
}): boolean {
  return input.hasCompletedInitialLayout && (input.stateChanged || input.hasInterruptedAnimation);
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface RestingComposerControlsMeasurement {
  gap: number;
  naturalFixedWidth: number;
  minimumFixedWidth: number;
  blockWidths: readonly number[];
  overflowWidth: number;
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
): number {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;
  return (
    fixedWidth +
    blockWidths.slice(0, visibleCount).reduce((sum, width) => sum + width, 0) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
}

export function resolveRestingComposerControlsNaturalWidth(
  input: RestingComposerControlsMeasurement,
): number {
  return restingComposerControlsWidth(input, 0);
}

const RESTING_CONTROLS_SLACK_PX = 1;

/**
 * Decide how many trailing resting control blocks move into the overflow
 * menu, and whether the cluster can show at all, from natural widths.
 *
 * Trailing blocks hide before the model picker shrinks. Once they are all in
 * the overflow menu, the picker may contract to its minimum readable width;
 * below that the whole cluster hides rather than clipping.
 */
export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: { hiddenCount: number; visible: boolean };
  },
): { hiddenCount: number; visible: boolean } {
  const { blockWidths, hostWidth, previous } = input;
  let hiddenCount = 0;
  while (
    hiddenCount < blockWidths.length &&
    restingComposerControlsWidth(input, hiddenCount) > hostWidth
  ) {
    hiddenCount += 1;
  }
  if (previous) {
    const previousHiddenCount = Math.min(previous.hiddenCount, blockWidths.length);
    while (
      hiddenCount < previousHiddenCount &&
      restingComposerControlsWidth(input, hiddenCount) > hostWidth - RESTING_CONTROLS_SLACK_PX
    ) {
      hiddenCount += 1;
    }
  }
  const minimumWidth = restingComposerControlsWidth(input, hiddenCount, input.minimumFixedWidth);
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth;
  return { hiddenCount, visible };
}
