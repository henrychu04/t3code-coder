import { getFiletypeFromFileName } from "@pierre/diffs";
import type { ProjectTextSearchMatch } from "@t3tools/contracts";
import { memo, Suspense, use, useMemo, type CSSProperties } from "react";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

interface Range {
  readonly start: number;
  readonly end: number;
}

interface CodeToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

function normalizeRanges(match: ProjectTextSearchMatch): Range[] {
  const ranges = match.matchRanges
    .map((range) => ({
      start: Math.max(0, Math.min(match.lineContent.length, range.start)),
      end: Math.max(0, Math.min(match.lineContent.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function tokenStyle(token: CodeToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

function HighlightedTokens(props: {
  readonly line: string;
  readonly ranges: ReadonlyArray<Range>;
  readonly tokens: ReadonlyArray<CodeToken>;
}) {
  return props.tokens.flatMap((token) => {
    const parts = [];
    const tokenEnd = token.offset + token.content.length;
    let cursor = token.offset;
    for (const range of props.ranges) {
      if (range.end <= cursor) continue;
      if (range.start >= tokenEnd) break;
      const start = Math.max(cursor, range.start);
      if (start > cursor) {
        parts.push(
          <span key={`${cursor}:${start}:code`} style={tokenStyle(token)}>
            {props.line.slice(cursor, start)}
          </span>,
        );
      }
      const end = Math.min(tokenEnd, range.end);
      parts.push(
        <mark
          className="rounded-[2px] bg-primary/25 text-inherit"
          key={`${start}:${end}:match`}
          style={tokenStyle(token)}
        >
          {props.line.slice(start, end)}
        </mark>,
      );
      cursor = end;
    }
    if (cursor < tokenEnd) {
      parts.push(
        <span key={`${cursor}:${tokenEnd}:code`} style={tokenStyle(token)}>
          {props.line.slice(cursor, tokenEnd)}
        </span>,
      );
    }
    return parts;
  });
}

function SyntaxHighlightedTokens(props: {
  readonly line: string;
  readonly language: string;
  readonly ranges: ReadonlyArray<Range>;
  readonly theme: "light" | "dark";
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const tokens = useMemo(() => {
    try {
      return highlighter.codeToTokens(props.line, {
        lang: props.language,
        theme: resolveDiffThemeName(props.theme),
      }).tokens[0];
    } catch {
      return undefined;
    }
  }, [highlighter, props.language, props.line, props.theme]);
  return (
    <HighlightedTokens
      line={props.line}
      ranges={props.ranges}
      tokens={tokens ?? [{ content: props.line, offset: 0 }]}
    />
  );
}

export const HighlightedSearchLine = memo(function HighlightedSearchLine(props: {
  readonly match: ProjectTextSearchMatch;
  readonly path: string;
  readonly theme: "light" | "dark";
}) {
  const ranges = useMemo(() => normalizeRanges(props.match), [props.match]);
  const fallback = (
    <HighlightedTokens
      line={props.match.lineContent}
      ranges={ranges}
      tokens={[{ content: props.match.lineContent, offset: 0 }]}
    />
  );
  return (
    <RenderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <SyntaxHighlightedTokens
          line={props.match.lineContent}
          language={getFiletypeFromFileName(props.path)}
          ranges={ranges}
          theme={props.theme}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
});
