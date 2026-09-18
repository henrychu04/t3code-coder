import { useImperativeHandle, useMemo, useRef } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import { EMPTY_PASTED_IMAGES, type ComposerPastedImage } from "~/lib/composerPastedImages";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  encodeCoderComposerContext,
  decodeCoderComposerContext,
  type CoderDraftContextRecord,
} from "~/lib/coderComposerContext";
import { longTextContextReference } from "~/lib/composerInlineContext";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { ComposerImagesContext } from "./ComposerContextNode";
import { ComposerContextActionsContext } from "./composerContextPresentation";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle as CoreHandle,
} from "./ComposerPromptEditorTiptap";
export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /**
   * True when a collapsed caret sits on the first ("start") or last ("end")
   * visual line, counting soft wraps. Prompt history only claims ArrowUp and
   * ArrowDown at these edges so arrows still move the caret inside multiline
   * text.
   */
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  /**
   * Render Markdown styling (bold, italic, code, strike, task checkboxes).
   * Off renders the same Tiptap engine as plain text: every marker stays a
   * literal character.
   */
  richTextEnabled?: boolean;
  fileActions?: {
    openPullRequest?: (event: React.MouseEvent<HTMLElement>, url: string) => void;
    openMention: (path: string) => void;
    canOpenMention: (path: string) => boolean;
  };
  images?: ReadonlyArray<ComposerPastedImage>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  onRemoveTerminalContext: (contextId: string) => void;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
    restoredTerminalContexts?: TerminalContextDraft[],
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
    isTaskItem?: boolean,
  ) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
};

/** Coder's serialization and access boundaries surround the upstream context-aware editor. */
export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  const coreRef = useRef<CoreHandle>(null);
  const encoded = useMemo(
    () => encodeCoderComposerContext(props.value, props.terminalContexts),
    [props.value, props.terminalContexts],
  );
  // Keep payloads available to upstream undo/redo and same-editor cut/paste. Nothing is
  // exported to the clipboard or persisted locally; the editor owns this history cache.
  const historyRecords = useRef(new Map<string, CoderDraftContextRecord>());
  for (const [id, record] of encoded.records) historyRecords.current.set(id, record);
  const records = historyRecords.current;
  const terminalsFor = (ids: string[]) =>
    ids.flatMap((id) => {
      const record = Array.from(records.values()).find((entry) => entry.terminal?.id === id);
      return record?.terminal ? [record.terminal] : [];
    });
  const decode = (value: string, offset = 0) => decodeCoderComposerContext(value, records, offset);
  const snapshot = () => {
    const current = coreRef.current?.readSnapshot();
    if (!current)
      return {
        value: props.value,
        cursor: props.cursor,
        expandedCursor: 0,
        terminalContextIds: props.terminalContexts.map((item) => item.id),
      };
    const result = decode(current.value, current.expandedCursor);
    return {
      value: result.value,
      cursor: current.cursor,
      expandedCursor: result.offset,
      terminalContextIds: result.terminalContextIds,
    };
  };
  useImperativeHandle(props.editorRef, () => ({
    focus: () => coreRef.current?.focus(),
    focusAt: (cursor) => coreRef.current?.focusAt(cursor),
    focusAtEnd: () => coreRef.current?.focusAtEnd(),
    isCaretOnVisualEdge: (edge) => coreRef.current?.isCaretOnVisualEdge(edge) ?? false,
    readSnapshot: snapshot,
    readSelectionRange: () => {
      const range = coreRef.current?.readSelectionRange() ?? { start: 0, end: 0 };
      const value = coreRef.current?.readSnapshot().value ?? encoded.value;
      return { start: decode(value, range.start).offset, end: decode(value, range.end).offset };
    },
    requestCitationComment: (request) => {
      const next = encodeCoderComposerContext(
        request.value,
        props.terminalContexts,
        request.citationStart,
      );
      coreRef.current?.requestCitationComment({
        ...request,
        previousValue: encodeCoderComposerContext(request.previousValue, props.terminalContexts)
          .value,
        value: next.value,
        citationStart: next.offset,
      });
    },
  }));
  const replaceContext = (id: string, source: string) => {
    const current = coreRef.current?.readSnapshot();
    const record = records.get(id);
    if (!current || !record) return;
    const replacements = new Map(records);
    replacements.set(id, { ...record, source });
    const result = decodeCoderComposerContext(current.value, replacements, current.expandedCursor);
    props.onChange(
      result.value,
      collapseExpandedComposerCursor(result.value, result.offset),
      result.offset,
      false,
      result.terminalContextIds,
    );
  };
  return (
    <ComposerImagesContext value={props.images ?? EMPTY_PASTED_IMAGES}>
      <ComposerContextActionsContext
        value={{
          openPullRequest: props.fileActions?.openPullRequest ?? (() => {}),
          openMention: props.fileActions?.openMention ?? (() => {}),
          canOpenMention: props.fileActions?.canOpenMention ?? (() => false),
          replaceContext,
          disabled: props.disabled,
        }}
      >
        <ComposerPromptEditorTiptap
          {...props}
          value={encoded.value}
          contextRecords={records}
          editorRef={coreRef}
          onChange={(value, _cursor, expandedCursor, adjacent) => {
            const result = decode(value, expandedCursor);
            props.onChange(
              result.value,
              collapseExpandedComposerCursor(result.value, result.offset),
              result.offset,
              adjacent,
              result.terminalContextIds,
              terminalsFor(result.terminalContextIds),
            );
          }}
          onPaste={(event) => {
            props.onPaste(event);
            const text = event.clipboardData.getData("text/plain");
            if (event.defaultPrevented || text.length < 32 * 1024) return;
            event.preventDefault();
            const current = coreRef.current?.readSnapshot();
            const range = coreRef.current?.readSelectionRange();
            if (!current || !range) return;
            const old = decode(current.value).value;
            const start = decode(current.value, range.start).offset;
            const end = decode(current.value, range.end).offset;
            const replacement = longTextContextReference(text);
            const value = old.slice(0, start) + replacement + old.slice(end);
            const offset = start + replacement.length;
            props.onChange(
              value,
              collapseExpandedComposerCursor(value, offset),
              offset,
              false,
              decode(current.value).terminalContextIds,
            );
          }}
        />
      </ComposerContextActionsContext>
    </ComposerImagesContext>
  );
}
