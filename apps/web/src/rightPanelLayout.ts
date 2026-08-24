export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0";

export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "t3code:coder-right-panel-width:v1";
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const RIGHT_PANEL_DEFAULT_MAX_WIDTH = 52 * 16;
export const RIGHT_PANEL_SIBLING_MIN_WIDTH = 360;

const RIGHT_PANEL_DEFAULT_WIDTH_FRACTION = 0.48;
const RIGHT_PANEL_MAX_WIDTH_FRACTION = 0.7;

export function resolveRightPanelWidths(
  viewportWidth: number,
  containerWidth?: number,
): {
  readonly defaultWidth: number;
  readonly maxWidth: number;
} {
  const containerCap =
    containerWidth === undefined
      ? Infinity
      : Math.floor(containerWidth) - RIGHT_PANEL_SIBLING_MIN_WIDTH;
  const maxWidth = Math.max(
    RIGHT_PANEL_MIN_WIDTH,
    Math.min(
      Math.floor(viewportWidth * RIGHT_PANEL_MAX_WIDTH_FRACTION),
      containerCap,
    ),
  );

  return {
    defaultWidth: Math.min(
      maxWidth,
      RIGHT_PANEL_DEFAULT_MAX_WIDTH,
      Math.max(
        RIGHT_PANEL_MIN_WIDTH,
        Math.floor((containerWidth ?? viewportWidth) * RIGHT_PANEL_DEFAULT_WIDTH_FRACTION),
      ),
    ),
    maxWidth,
  };
}
