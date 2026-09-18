import {
  formatComposerContextReference,
  collectComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { splitPromptIntoComposerSegments } from "../composer-editor-mentions";
import { toKindScopedComposerContextId } from "./composerContextReferences";
import type { TerminalContextDraft } from "./terminalContext";
import type { ComposerInlineContext } from "./composerInlineContext";

/** The editor uses upstream references; legacy Coder drafts and provider prompts retain their format. */
export type CoderDraftContextRecord = {
  kind: string;
  source: string;
  terminal?: TerminalContextDraft | null;
  context?: ComposerInlineContext;
};

type Replacement = { start: number; end: number; value: string };
export function replaceContextSpans(
  text: string,
  replacements: readonly Replacement[],
  offset = 0,
) {
  let value = "";
  let previous = 0;
  let mappedOffset = offset;
  for (const replacement of replacements) {
    value += text.slice(previous, replacement.start) + replacement.value;
    if (offset >= replacement.end)
      mappedOffset += replacement.value.length - (replacement.end - replacement.start);
    else if (offset > replacement.start) mappedOffset = value.length;
    previous = replacement.end;
  }
  return { value: value + text.slice(previous), offset: mappedOffset };
}

export function encodeCoderComposerContext(
  value: string,
  terminals: readonly TerminalContextDraft[],
  offset = 0,
) {
  const records = new Map<string, CoderDraftContextRecord>();
  const replacements: Replacement[] = [];
  let start = 0;
  for (const segment of splitPromptIntoComposerSegments(value, terminals)) {
    const source =
      segment.type === "text"
        ? segment.text
        : segment.type === "terminal-context"
          ? "\uFFFC"
          : segment.source;
    if (segment.type === "context" || segment.type === "terminal-context") {
      const kind = segment.type === "terminal-context" ? "terminal" : segment.context.kind;
      const producerId =
        segment.type === "terminal-context"
          ? (segment.context?.id ?? `unavailable-${start}`)
          : segment.context.kind === "image"
            ? segment.context.imageId
            : segment.context.kind === "review-comment"
              ? `${segment.context.comment.id}:${source}`
              : source;
      const contextId = toKindScopedComposerContextId(kind, producerId);
      const label =
        segment.type === "terminal-context"
          ? (segment.context?.terminalLabel ?? "Terminal")
          : segment.context.kind === "image"
            ? "Image"
            : segment.context.kind === "text"
              ? "Long text"
              : segment.context.comment.rangeLabel;
      records.set(
        contextId,
        segment.type === "terminal-context"
          ? { kind, source, terminal: segment.context }
          : { kind, source, context: segment.context },
      );
      replacements.push({
        start,
        end: start + source.length,
        value: formatComposerContextReference({ kind, contextId, label }),
      });
    }
    start += source.length;
  }
  return { ...replaceContextSpans(value, replacements, offset), records };
}

export function decodeCoderComposerContext(
  value: string,
  records: ReadonlyMap<string, CoderDraftContextRecord>,
  offset = 0,
) {
  const terminals: string[] = [];
  const replacements: Replacement[] = [];
  for (const reference of collectComposerContextReferences(value)) {
    const record = records.get(reference.contextId);
    if (!record) continue;
    if (record.terminal) terminals.push(record.terminal.id);
    replacements.push({ start: reference.start, end: reference.end, value: record.source });
  }
  return { ...replaceContextSpans(value, replacements, offset), terminalContextIds: terminals };
}
