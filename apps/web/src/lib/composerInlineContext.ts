import {
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../reviewCommentContext";

export type ComposerInlineContext =
  | { readonly kind: "review-comment"; readonly comment: ReviewCommentContext }
  | { readonly kind: "image"; readonly imageId: string }
  | { readonly kind: "text"; readonly text: string };

export function imageContextReference(id: string): string {
  return `[Image](t3-pasted-image://${id})`;
}

export function collectImageContextReferences(text: string) {
  return [...text.matchAll(/\[Image\]\(t3-pasted-image:\/\/([0-9a-f-]{36})\)/gi)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    source: match[0],
    id: match[1]!,
  }));
}

export function collectInlineComposerContexts(text: string) {
  const matches: {
    start: number;
    end: number;
    source: string;
    context: ComposerInlineContext;
    type: "context";
  }[] = [];
  for (const match of text.matchAll(/<review_comment\b[^>]*>[\s\S]*?<\/review_comment>/g)) {
    const parsed = parseReviewCommentMessageSegments(match[0])[0];
    if (parsed?.kind === "review-comment")
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        source: match[0],
        type: "context",
        context: { kind: "review-comment", comment: parsed.comment },
      });
  }
  for (const match of collectImageContextReferences(text)) {
    if (!matches.some((entry) => match.start >= entry.start && match.start < entry.end)) {
      matches.push({ ...match, type: "context", context: { kind: "image", imageId: match.id } });
    }
  }
  for (const match of text.matchAll(/\[Long text\]\(t3-inline-text:\/\/([^)]*)\)/g)) {
    if (matches.some((entry) => match.index >= entry.start && match.index < entry.end)) continue;
    try {
      const value = decodeURIComponent(match[1]!);
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        source: match[0],
        type: "context",
        context: { kind: "text", text: value },
      });
    } catch {
      /* A malformed reference remains editable text. */
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Stable, memory-only boundaries; the send path expands this back to ordinary prompt text. */
export function longTextContextReference(text: string): string {
  return `[Long text](t3-inline-text://${encodeURIComponent(text).replaceAll("(", "%28").replaceAll(")", "%29")})`;
}

export function expandLongTextContexts(prompt: string): string {
  for (const entry of collectInlineComposerContexts(prompt).reverse()) {
    if (entry.context.kind === "text")
      prompt = prompt.slice(0, entry.start) + entry.context.text + prompt.slice(entry.end);
  }
  return prompt;
}

/** References inside quoted review material are ordinary source text. */
export function collectDraftImageReferences(prompt: string) {
  return collectInlineComposerContexts(prompt).flatMap((entry) =>
    entry.context.kind === "image"
      ? [{ start: entry.start, end: entry.end, id: entry.context.imageId }]
      : [],
  );
}
