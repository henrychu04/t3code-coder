interface LineGeometry {
  readonly top: number;
  readonly height: number;
}

interface RenderedFileLineGeometry {
  readonly lineNumber: number;
  readonly top: number;
  readonly bottom: number;
}

const FILE_LINE_VISIBILITY_EPSILON = 0.5;

export function resolveVisibleFileLineAnchor(input: {
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly lines: readonly RenderedFileLineGeometry[];
}): { lineNumber: number; viewportOffset: number } | undefined {
  const anchor =
    input.lines.find(
      (line) =>
        line.top >= input.viewportTop - FILE_LINE_VISIBILITY_EPSILON &&
        line.bottom <= input.viewportBottom + FILE_LINE_VISIBILITY_EPSILON,
    ) ??
    input.lines.find(
      (line) => line.bottom > input.viewportTop && line.top < input.viewportBottom,
    );
  if (!anchor) return undefined;
  return {
    lineNumber: anchor.lineNumber,
    viewportOffset: anchor.top - input.viewportTop,
  };
}

export function resolveCenteredFileLineScrollTop(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly fileTop: number;
  readonly estimatedLine: LineGeometry;
  readonly renderedLine?: LineGeometry;
}): number {
  const lineTop = input.renderedLine
    ? input.scrollTop + input.renderedLine.top - input.viewportTop
    : input.fileTop + input.estimatedLine.top;
  const lineHeight = input.renderedLine?.height ?? input.estimatedLine.height;
  const centeredTop = Math.max(0, lineTop - Math.max(0, (input.viewportHeight - lineHeight) / 2));
  return Math.min(centeredTop, Math.max(0, input.scrollHeight - input.viewportHeight));
}

export function resolveAnchoredFileLineScrollTop(input: {
  readonly scrollHeight: number;
  readonly viewportHeight: number;
  readonly fileTop: number;
  readonly lineTop: number;
  readonly viewportOffset: number;
}): number {
  const anchoredTop = Math.max(0, input.fileTop + input.lineTop - input.viewportOffset);
  return Math.min(anchoredTop, Math.max(0, input.scrollHeight - input.viewportHeight));
}
