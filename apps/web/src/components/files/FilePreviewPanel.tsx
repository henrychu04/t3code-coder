import {
  type DiffLineAnnotation,
  type FileContents,
  type SelectedLineRange,
  VirtualizedFile,
} from "@pierre/diffs";
import { EditContext, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectWriteFileResult, ScopedThreadRef } from "@t3tools/contracts";
import { Check, ChevronRight, Code2, Copy, Eye, FolderTree, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { DiffCommentAnnotation } from "~/components/diffs/DiffCommentAnnotation";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import {
  type FileEditorViewAnchor,
  bindFileEditorSession,
  confirmFileEditorSession,
  discardFileEditorSession,
  getFileEditorSession,
} from "./fileEditorSessions";
import { projectFileCacheKey } from "./fileContentRevision";
import {
  resolveAnchoredFileLineScrollTop,
  resolveCenteredFileLineScrollTop,
  resolveVisibleFileLineAnchor,
} from "./fileLineReveal";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  discardProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}
  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line],
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background: color-mix(in srgb, var(--primary) 18%, transparent) !important;
  }
`;
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function clampFileLine(contents: string, requestedLine: number): number {
  const count = contents.split(/\r\n|\r|\n/).length;
  return Math.min(Math.max(1, requestedLine), count);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;
  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const stateRef = useRef<{ requestId: number | null; frame: number | null }>({
    requestId: null,
    frame: null,
  });
  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (phase === "unmount") {
        if (stateRef.current.frame !== null) cancelAnimationFrame(stateRef.current.frame);
        stateRef.current.frame = null;
        return;
      }
      const contents = instance.file?.contents;
      const line =
        revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, line);
      if (
        relativePath === null ||
        line === null ||
        !(instance instanceof VirtualizedFile) ||
        stateRef.current.requestId === revealRequestId ||
        stateRef.current.frame !== null
      ) {
        return;
      }
      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      const attemptReveal = (attempt: number) => {
        stateRef.current.frame = requestAnimationFrame(() => {
          stateRef.current.frame = null;
          const position = instance.getLinePosition(line);
          if (!position) {
            if (attempt < 30) attemptReveal(attempt + 1);
            return;
          }
          const viewport = scrollContainer.getBoundingClientRect();
          const fileTop =
            scrollContainer.scrollTop + fileContainer.getBoundingClientRect().top - viewport.top;
          const rendered = (fileContainer.shadowRoot ?? fileContainer)
            .querySelector<HTMLElement>(`[data-line="${line}"]`)
            ?.getBoundingClientRect();
          scrollContainer.scrollTop = resolveCenteredFileLineScrollTop({
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            viewportTop: viewport.top,
            viewportHeight: scrollContainer.clientHeight,
            fileTop,
            estimatedLine: position,
            ...(rendered ? { renderedLine: { top: rendered.top, height: rendered.height } } : {}),
          });
          stateRef.current.requestId = revealRequestId;
          updateFileLinkReveal(fileContainer, line);
        });
      };
      attemptReveal(0);
    },
    [relativePath, revealLine, revealRequestId],
  );
}

function captureFileViewAnchor(
  fileContainer: HTMLElement,
  instance: VirtualizedFile<unknown>,
): FileEditorViewAnchor | undefined {
  const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
  if (!scrollContainer || scrollContainer.scrollTop === 0) return undefined;
  const viewport = scrollContainer.getBoundingClientRect();
  const renderedAnchor = resolveVisibleFileLineAnchor({
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    lines: [
      ...(fileContainer.shadowRoot ?? fileContainer).querySelectorAll<HTMLElement>(
        "[data-line], [data-column-number]",
      ),
    ].flatMap((element) => {
      const lineNumber = Number(element.dataset.line ?? element.dataset.columnNumber);
      if (!Number.isFinite(lineNumber) || lineNumber < 1) return [];
      const bounds = element.getBoundingClientRect();
      return [{ lineNumber, top: bounds.top, bottom: bounds.bottom }];
    }),
  });
  if (renderedAnchor) {
    return renderedAnchor;
  }
  const fileTop =
    scrollContainer.scrollTop + fileContainer.getBoundingClientRect().top - viewport.top;
  const lineAnchor = instance.getNumericScrollAnchor(
    Math.max(0, scrollContainer.scrollTop - fileTop),
  );
  if (!lineAnchor) return undefined;
  return {
    lineNumber: lineAnchor.lineNumber,
    viewportOffset: fileTop + lineAnchor.top - scrollContainer.scrollTop,
  };
}

function useRetainedFileViewAnchor(
  editorSession: { viewAnchor: FileEditorViewAnchor | undefined },
  enabled: boolean,
  onPostRender: FilePostRender,
): FilePostRender {
  const stateRef = useRef<{ frame: number | null; restored: boolean }>({
    frame: null,
    restored: false,
  });
  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);
      if (!(instance instanceof VirtualizedFile)) return;
      if (phase === "unmount") {
        if (stateRef.current.frame !== null) cancelAnimationFrame(stateRef.current.frame);
        stateRef.current.frame = null;
        stateRef.current.restored = false;
        editorSession.viewAnchor = captureFileViewAnchor(fileContainer, instance);
        return;
      }
      const anchor = editorSession.viewAnchor;
      if (!enabled || !anchor || stateRef.current.restored || stateRef.current.frame !== null) {
        return;
      }
      const attemptRestore = (attempt: number) => {
        stateRef.current.frame = requestAnimationFrame(() => {
          stateRef.current.frame = null;
          if (attempt < 2) {
            attemptRestore(attempt + 1);
            return;
          }
          const scrollContainer = fileContainer.closest<HTMLElement>(
            ".file-preview-virtualizer",
          );
          const linePosition = instance.getLinePosition(anchor.lineNumber);
          if (!scrollContainer || !linePosition || !fileContainer.isConnected) {
            if (attempt < 30) attemptRestore(attempt + 1);
            return;
          }
          const viewport = scrollContainer.getBoundingClientRect();
          const fileTop =
            scrollContainer.scrollTop + fileContainer.getBoundingClientRect().top - viewport.top;
          scrollContainer.scrollTop = resolveAnchoredFileLineScrollTop({
            scrollHeight: scrollContainer.scrollHeight,
            viewportHeight: scrollContainer.clientHeight,
            fileTop,
            lineTop: linePosition.top,
            viewportOffset: anchor.viewportOffset,
          });
          const renderedLine = (fileContainer.shadowRoot ?? fileContainer)
            .querySelector<HTMLElement>(`[data-line="${anchor.lineNumber}"]`)
            ?.getBoundingClientRect();
          if (!renderedLine) {
            if (attempt < 30) attemptRestore(attempt + 1);
            return;
          }
          const renderedViewport = scrollContainer.getBoundingClientRect();
          scrollContainer.scrollTop = resolveAnchoredFileLineScrollTop({
            scrollHeight: scrollContainer.scrollHeight,
            viewportHeight: scrollContainer.clientHeight,
            fileTop: scrollContainer.scrollTop,
            lineTop: renderedLine.top - renderedViewport.top,
            viewportOffset: anchor.viewportOffset,
          });
          stateRef.current.restored = true;
        });
      };
      attemptRestore(0);
    },
    [editorSession, enabled, onPostRender],
  );
}

function useFileSaveCoordinator(input: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  relativePath: string;
  revision: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const revisionRef = useRef(input.revision);
  useEffect(() => {
    revisionRef.current = input.revision;
  }, [input.revision]);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator<ProjectWriteFileResult>({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => input.onPendingChange(input.relativePath, pending),
        onFailed: () => input.onSaveFailed(input.relativePath),
        persist: (contents) =>
          writeFile({
            environmentId: input.environmentId,
            input: {
              threadId: input.threadRef.threadId,
              cwd: input.cwd,
              relativePath: input.relativePath,
              contents,
              expectedRevision: revisionRef.current,
            },
          }),
        onConfirmed: (contents, result) => {
          revisionRef.current = result.revision;
          confirmFileEditorSession(
            {
              threadRef: input.threadRef,
              cwd: input.cwd,
              relativePath: input.relativePath,
            },
            contents,
            result.revision,
          );
          confirmProjectFileQueryData(
            input.environmentId,
            input.threadRef.threadId,
            input.cwd,
            input.relativePath,
            contents,
            result.revision,
          );
        },
      }),
    [
      input.cwd,
      input.environmentId,
      input.onPendingChange,
      input.onSaveFailed,
      input.relativePath,
      input.threadRef.threadId,
      writeFile,
    ],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}

function EditableFileSurface(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  revision: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  restoreViewAnchor: boolean;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const saveCoordinator = useFileSaveCoordinator(props);
  const handleEditorChange = useCallback(
    (file: FileContents, nextAnnotations?: DiffLineAnnotation<FileCommentAnnotationGroup>[]) => {
      setProjectFileQueryData(
        props.environmentId,
        props.threadRef.threadId,
        props.cwd,
        props.relativePath,
        file.contents,
      );
      saveCoordinator.change(file.contents);
      if (!nextAnnotations) return;
      const remapped = remapFileCommentAnnotations(nextAnnotations as FileCommentLineAnnotation[]);
      setLineAnnotations(remapped);
      for (const annotation of remapped) {
        for (const entry of annotation.metadata.entries) {
          if (entry.kind !== "comment") continue;
          addReviewComment(
            props.composerDraftTarget,
            buildFileReviewComment({
              id: entry.id,
              filePath: props.relativePath,
              startLine: entry.startLine,
              endLine: entry.endLine,
              text: entry.text,
              contents: file.contents,
            }),
          );
        }
      }
    },
    [
      addReviewComment,
      props.composerDraftTarget,
      props.cwd,
      props.environmentId,
      props.relativePath,
      props.threadRef.threadId,
      saveCoordinator,
    ],
  );
  const editorSession = useMemo(
    () =>
      getFileEditorSession(
        {
          threadRef: props.threadRef,
          cwd: props.cwd,
          relativePath: props.relativePath,
        },
        props.contents,
        props.revision,
      ),
    [props.contents, props.cwd, props.relativePath, props.revision, props.threadRef],
  );
  const editor = editorSession.editor;
  const onPostRender = useRetainedFileViewAnchor(
    editorSession,
    props.restoreViewAnchor,
    props.onPostRender,
  );
  useLayoutEffect(
    () => bindFileEditorSession(editorSession, handleEditorChange),
    [editorSession, handleEditorChange],
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const verifyRestoredViewport = (attempt: number) => {
      timer = setTimeout(() => {
        timer = null;
        const scrollContainer = surfaceRef.current?.querySelector<HTMLElement>(
          ".file-preview-virtualizer",
        );
        const fileContainer = scrollContainer?.querySelector<HTMLElement>("diffs-container");
        const editable = fileContainer?.shadowRoot?.querySelector<HTMLElement>(
          '[contenteditable="true"]',
        );
        if (!scrollContainer || !editable || scrollContainer.clientHeight === 0) {
          if (attempt < 4) verifyRestoredViewport(attempt + 1);
          return;
        }
        if (scrollContainer.scrollTop === 0) return;
        const viewport = scrollContainer.getBoundingClientRect();
        const content = editable.getBoundingClientRect();
        if (content.bottom > viewport.top && content.top < viewport.bottom) return;
        scrollContainer.scrollTop = 0;
      }, 250);
    };
    verifyRestoredViewport(0);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [editorSession]);

  const removeAnnotation = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(props.composerDraftTarget, entryId);
      setLineAnnotations((current) =>
        current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        }),
      );
    },
    [props.composerDraftTarget, removeReviewComment],
  );
  const submitAnnotation = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          props.composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: props.relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents: props.contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((candidate) =>
              candidate.id === entryId ? { ...candidate, kind: "comment", text } : candidate,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      lineAnnotations,
      props.composerDraftTarget,
      props.contents,
      props.relativePath,
    ],
  );
  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draft: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existing = withoutDraft.find((annotation) => annotation.lineNumber === endLine);
      return existing
        ? withoutDraft.map((annotation) =>
            annotation === existing
              ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, draft] } }
              : annotation,
          )
        : [...withoutDraft, { lineNumber: endLine, metadata: { entries: [draft] } }];
    });
  }, []);
  const hasDraft = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasDraft,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasDraft]);

  return (
    <EditContext.Provider value={editor}>
      <div ref={surfaceRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: props.relativePath,
              contents: editorSession.contents,
              cacheKey: editorSession.cacheKey,
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasDraft,
              enableLineSelection: !hasDraft,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: (range) => {
                setSelectedRange(range);
                if (range) beginComment(range);
              },
              overflow: props.wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(props.resolvedTheme),
              themeType: props.resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <DiffCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotation(entry.id)}
                    onComment={(text) => submitAnnotation(entry.id, text)}
                    onDelete={() => removeAnnotation(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditContext.Provider>
  );
}

function RenderedMarkdownSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  threadRef: ScopedThreadRef;
  contents: string;
  revision: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}) {
  const saveCoordinator = useFileSaveCoordinator(props);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={props.contents}
        cwd={props.cwd}
        threadRef={props.threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) => {
          const current =
            getOptimisticProjectFileQueryData(props.environmentId, props.cwd, props.relativePath)
              ?.contents ?? props.contents;
          const next = setMarkdownTaskChecked(current, markerOffset, checked);
          if (next === current) return;
          setProjectFileQueryData(
            props.environmentId,
            props.threadRef.threadId,
            props.cwd,
            props.relativePath,
            next,
          );
          saveCoordinator.change(next);
        }}
      />
    </ScrollArea>
  );
}

export default function FilePreviewPanel(props: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const file = useProjectFileQuery(
    props.environmentId,
    props.threadRef.threadId,
    props.cwd,
    props.relativePath,
  );
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [renderMarkdown, setRenderMarkdown] = useState(false);
  const [saveFailedPath, setSaveFailedPath] = useState<string | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = props.relativePath ? isMarkdownPreviewFile(props.relativePath) : false;
  const breadcrumbs = useMemo(
    () => (props.relativePath ? fileBreadcrumbs(props.projectName, props.relativePath) : []),
    [props.projectName, props.relativePath],
  );
  const onPostRender = useFileLineReveal(
    props.relativePath,
    props.revealLine,
    props.revealRequestId,
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "project-relative path" });
  const handlePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (pending) setSaveFailedPath((current) => (current === relativePath ? null : current));
      props.onPendingChange(relativePath, pending);
    },
    [props.onPendingChange],
  );
  const reloadFile = useCallback(() => {
    if (!props.relativePath) return;
    discardFileEditorSession({
      threadRef: props.threadRef,
      cwd: props.cwd,
      relativePath: props.relativePath,
    });
    discardProjectFileQueryData(
      props.environmentId,
      props.threadRef.threadId,
      props.cwd,
      props.relativePath,
    );
    props.onPendingChange(props.relativePath, false);
    setSaveFailedPath(null);
  }, [props.cwd, props.environmentId, props.onPendingChange, props.relativePath, props.threadRef]);

  useEffect(() => {
    breadcrumbRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb='true']")
      ?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [props.relativePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {props.relativePath ? (
        <div className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 text-muted-foreground/60" />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "max-w-40 truncate",
                            crumb.kind === "file" ? "font-medium" : "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      {crumb.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-80">
                      {crumb.path || props.projectName}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ))}
            </div>
          </ScrollArea>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={isCopied}
                  onPressedChange={() => copyToClipboard(props.relativePath!, undefined)}
                  aria-label="Copy project-relative path"
                  variant="ghost"
                  size="sm"
                >
                  {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Toggle>
              }
            />
            <TooltipPopup>{isCopied ? "Copied" : "Copy path"}</TooltipPopup>
          </Tooltip>
          {isMarkdown ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={renderMarkdown}
                    onPressedChange={setRenderMarkdown}
                    aria-label={renderMarkdown ? "Show Markdown source" : "Show rendered Markdown"}
                    variant="ghost"
                    size="sm"
                  >
                    {renderMarkdown ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Toggle>
                }
              />
              <TooltipPopup>{renderMarkdown ? "Show source" : "Render Markdown"}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={setExplorerOpen}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>{explorerOpen ? "Hide explorer" : "Show explorer"}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {props.relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      {props.relativePath && saveFailedPath === props.relativePath ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive-foreground">
          <span className="min-w-0 flex-1 truncate">
            Could not save. The file may have changed in the workspace.
          </span>
          <Button size="xs" variant="outline" onClick={reloadFile}>
            Reload and discard edits
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            props.relativePath ? "flex" : "hidden",
          )}
        >
          {props.relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
              {file.error}
            </div>
          ) : props.relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : props.relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                relativePath={props.relativePath}
                contents={file.data.contents}
                revision={file.data.revision}
                onPendingChange={handlePendingChange}
                onSaveFailed={setSaveFailedPath}
              />
            ) : file.data.truncated ? (
              <Virtualizer className="file-preview-virtualizer min-h-0 flex-1 overflow-auto">
                <File
                  file={{
                    name: props.relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(
                      props.cwd,
                      props.relativePath,
                      file.data.contents,
                    ),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                key={`${props.relativePath}:${resolvedTheme}`}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                relativePath={props.relativePath}
                composerDraftTarget={props.composerDraftTarget}
                contents={file.data.contents}
                revision={file.data.revision}
                resolvedTheme={resolvedTheme}
                revealRequestId={props.revealRequestId}
                restoreViewAnchor={props.revealLine === null}
                wordWrap={wordWrap}
                onPostRender={onPostRender}
                onPendingChange={handlePendingChange}
                onSaveFailed={setSaveFailedPath}
              />
            )
          ) : null}
        </div>
        {explorerOpen || props.relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              props.relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${props.environmentId}:${props.cwd}`}
              environmentId={props.environmentId}
              threadId={props.threadRef.threadId}
              cwd={props.cwd}
              projectName={props.projectName}
              selectedPath={props.relativePath}
              selectedPathRevealId={props.revealRequestId}
              onOpenFile={props.onOpenFile}
              {...(props.relativePath ? { onRefreshSelectedFile: file.refresh } : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
