import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import {
  type DiffLineAnnotation,
  type FileContents,
  type SelectedLineRange,
  VirtualizedFile,
} from "@pierre/diffs";
import { EditContext, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import {
  type EnvironmentId,
  PROJECT_SEARCH_INPUT_MAX_LENGTH,
  type ProjectTextSearchMatch,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  FileIcon,
  Filter,
  FolderTree,
  LoaderCircle,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { DiffCommentAnnotation } from "~/components/diffs/DiffCommentAnnotation";
import { Button } from "~/components/ui/button";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "~/components/ui/command";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { resolveShortcutCommand } from "~/keybindings";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { useProjectPathSearch, useProjectTextSearch } from "~/state/queries";
import { useEnvironmentKeybindings } from "~/state/environments";

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
import { HighlightedSearchLine } from "./HighlightedSearchLine";
import { findTextMatches, type FileTextMatch } from "./fileFind";
import { getFileSearchMatches } from "./fileSearchMatches";
import {
  type FileEditorViewAnchor,
  bindFileEditorSession,
  discardFileEditorSession,
  getFileEditorSession,
} from "./fileEditorSessions";
import { projectFileCacheKey } from "./fileContentRevision";
import {
  type FileLineRevealRequest,
  isSameFileLineRevealRequest,
  resolveAnchoredFileLineScrollTop,
  resolveCenteredFileLineScrollTop,
  resolveVisibleFileLineAnchor,
} from "./fileLineReveal";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import {
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
  onOpenFile: (relativePath: string, line?: number) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

type FileSearchCommandRequest = {
  readonly id: number;
  readonly command: "filePicker.toggle" | "projectSearch.toggle";
};

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

function parseLineColumn(value: string): { line: number; column: number } | null {
  const match = /^\s*(\d+)(?:\s*:\s*(\d+))?\s*$/.exec(value);
  if (!match?.[1]) return null;
  return {
    line: Math.max(1, Number.parseInt(match[1], 10)),
    column: Math.max(1, Number.parseInt(match[2] ?? "1", 10)),
  };
}

function GoToLineDialog(props: {
  open: boolean;
  initialValue: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (line: number, column: number) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = parseLineColumn(value);
  useEffect(() => {
    if (!props.open) return;
    setValue(props.initialValue);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [props.initialValue, props.open]);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed) return;
            props.onSubmit(parsed.line, parsed.column);
            props.onOpenChange(false);
            setValue("");
          }}
        >
          <DialogHeader className="pb-5">
            <DialogTitle className="text-lg">Go to line</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-3 px-6 pb-5">
            <label htmlFor="file-go-to-line" className="shrink-0 text-sm text-muted-foreground">
              Line and column
            </label>
            <Input
              id="file-go-to-line"
              ref={inputRef}
              autoFocus
              nativeInput
              aria-label="Line and column"
              placeholder="12:4"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </div>
          <DialogFooter className="py-3">
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!parsed}>
              OK
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function FileFindBar(props: {
  open: boolean;
  requestId: number;
  contents: string;
  onClose: () => void;
  onMatchChange: (match: FileTextMatch | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchResult = useMemo(
    () =>
      findTextMatches({
        contents: props.contents,
        query,
        caseSensitive,
        wholeWord,
        useRegex,
      }),
    [caseSensitive, props.contents, query, useRegex, wholeWord],
  );
  const matches = matchResult.matches;
  const resolvedIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  useEffect(() => setSelectedIndex(0), [caseSensitive, query, useRegex, wholeWord]);
  useEffect(() => {
    if (!props.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.open, props.requestId]);
  useEffect(() => {
    if (!props.open) return;
    props.onMatchChange(matches[resolvedIndex] ?? null);
  }, [matches, props.onMatchChange, props.open, resolvedIndex]);

  if (!props.open) return null;

  const navigate = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    setSelectedIndex((current) => (current + direction + matches.length) % matches.length);
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/25 px-2">
      <InputGroup className="h-8 min-w-0 flex-1 max-w-xl bg-background">
        <InputGroupAddon>
          <Search className="size-3.5 text-icon-muted" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          aria-label="Find in file"
          placeholder="Find in file"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              navigate(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="gap-0.5 pe-1">
          <Toggle
            pressed={caseSensitive}
            onPressedChange={setCaseSensitive}
            aria-label="Match case"
            size="sm"
            variant="ghost"
          >
            <CaseSensitive className="size-3.5" />
          </Toggle>
          <Toggle
            pressed={wholeWord}
            onPressedChange={setWholeWord}
            aria-label="Match whole word"
            size="sm"
            variant="ghost"
          >
            <WholeWord className="size-3.5" />
          </Toggle>
          <Toggle
            pressed={useRegex}
            onPressedChange={setUseRegex}
            aria-label="Use regular expression"
            size="sm"
            variant="ghost"
          >
            <span className="font-mono text-xs">.*</span>
          </Toggle>
        </InputGroupAddon>
      </InputGroup>
      <span className="w-16 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
        {query
          ? matchResult.regexError
            ? "Invalid regex"
            : matches.length > 0
              ? `${resolvedIndex + 1} of ${matches.length}${matchResult.truncated ? "+" : ""}`
              : "0 results"
          : ""}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        onClick={() => navigate(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        onClick={() => navigate(1)}
      >
        <ArrowDown />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <X />
      </Button>
    </div>
  );
}

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
  const stateRef = useRef<{ request: FileLineRevealRequest | null; frame: number | null }>({
    request: null,
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
      const request =
        relativePath === null || line === null
          ? null
          : { requestId: revealRequestId, relativePath, line };
      if (
        request === null ||
        !(instance instanceof VirtualizedFile) ||
        isSameFileLineRevealRequest(stateRef.current.request, request) ||
        stateRef.current.frame !== null
      ) {
        return;
      }
      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      const attemptReveal = (attempt: number) => {
        stateRef.current.frame = requestAnimationFrame(() => {
          stateRef.current.frame = null;
          const position = instance.getLinePosition(request.line);
          if (!position) {
            if (attempt < 30) attemptReveal(attempt + 1);
            return;
          }
          const viewport = scrollContainer.getBoundingClientRect();
          const fileTop =
            scrollContainer.scrollTop + fileContainer.getBoundingClientRect().top - viewport.top;
          const rendered = (fileContainer.shadowRoot ?? fileContainer)
            .querySelector<HTMLElement>(`[data-line="${request.line}"]`)
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
          stateRef.current.request = request;
          updateFileLinkReveal(fileContainer, request.line);
        });
      };
      attemptReveal(0);
    },
    [relativePath, revealLine, revealRequestId],
  );
}

function SearchFilePreview(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  relativePath: string | null;
  line: number | null;
  revealRequestId: number;
}) {
  const { resolvedTheme } = useTheme();
  const file = useProjectFileQuery(
    props.environmentId,
    props.threadRef.threadId,
    props.cwd,
    props.relativePath,
  );
  const onPostRender = useFileLineReveal(props.relativePath, props.line, props.revealRequestId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-code-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 text-xs">
        <FileIcon className="size-3.5 text-icon-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {props.relativePath ?? "File preview"}
        </span>
        {props.line ? <span className="text-muted-foreground">Line {props.line}</span> : null}
      </div>
      {!props.relativePath ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          Select a result to preview it.
        </div>
      ) : file.data === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {file.error ? (
            <span className="px-4 text-center text-xs text-destructive">{file.error}</span>
          ) : (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : (
        <Virtualizer className="file-preview-virtualizer min-h-0 flex-1 overflow-auto">
          <File
            file={{
              name: props.relativePath,
              contents: file.data.contents,
              cacheKey: projectFileCacheKey(props.cwd, props.relativePath, file.data.contents),
            }}
            options={{
              disableFileHeader: true,
              overflow: "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender,
            }}
            className="min-h-full"
          />
        </Virtualizer>
      )}
    </div>
  );
}

function SearchDialogHeader(props: {
  title: string;
  summary: string;
  summaryLive?: boolean;
  query: string;
  fileMask: string;
  queryPlaceholder: string;
  queryTestId?: string;
  queryOptions?: ReactNode;
  queryActiveDescendant?: string;
  queryControls?: string;
  onQueryChange: (value: string) => void;
  onFileMaskChange: (value: string) => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:h-11 sm:flex-nowrap sm:px-4 sm:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="shrink-0 whitespace-nowrap font-heading font-semibold text-sm">
            {props.title}
          </h2>
          <span
            aria-atomic={props.summaryLive || undefined}
            aria-live={props.summaryLive ? "polite" : undefined}
            className="min-w-0 truncate text-xs text-muted-foreground"
            role={props.summaryLive ? "status" : undefined}
          >
            {props.summary}
          </span>
        </div>
        <InputGroup className="h-7 w-full sm:ms-auto sm:w-64" variant="ghost">
          <InputGroupAddon>
            <InputGroupText className="shrink-0 overflow-visible! whitespace-nowrap">
              <Filter className="mx-0! size-3.5 shrink-0" />
              <span className="whitespace-nowrap text-[11px]">File mask:</span>
            </InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            aria-label="File mask"
            placeholder="*.ts, !*.test.ts"
            maxLength={PROJECT_SEARCH_INPUT_MAX_LENGTH}
            size="sm"
            spellCheck={false}
            value={props.fileMask}
            onChange={(event) =>
              props.onFileMaskChange(
                event.currentTarget.value.slice(0, PROJECT_SEARCH_INPUT_MAX_LENGTH),
              )
            }
          />
        </InputGroup>
      </div>
      <div className="px-[var(--command-shell-inset)] py-1.5">
        <InputGroup
          className="h-10 rounded-lg border-transparent! bg-transparent! shadow-none! ring-0! hover:bg-transparent! has-[input:focus-visible]:border-transparent! has-[input:focus-visible]:bg-transparent! has-[input:focus-visible]:ring-0!"
          variant="ghost"
        >
          <InputGroupAddon>
            <Search className="size-4 text-icon-muted" />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            data-testid={props.queryTestId}
            aria-activedescendant={props.queryActiveDescendant}
            aria-autocomplete={props.queryControls ? "list" : undefined}
            aria-controls={props.queryControls}
            aria-expanded={props.queryControls ? true : undefined}
            aria-label={props.title}
            role={props.queryControls ? "combobox" : undefined}
            placeholder={props.queryPlaceholder}
            maxLength={PROJECT_SEARCH_INPUT_MAX_LENGTH}
            size="lg"
            spellCheck={false}
            value={props.query}
            onChange={(event) =>
              props.onQueryChange(
                event.currentTarget.value.slice(0, PROJECT_SEARCH_INPUT_MAX_LENGTH),
              )
            }
          />
          {props.queryOptions ? (
            <InputGroupAddon align="inline-end" className="gap-0.5 pe-1">
              {props.queryOptions}
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
    </div>
  );
}

function SearchDialogFooter() {
  return (
    <CommandFooter className="shrink-0 gap-3 border-t border-border/60 max-sm:flex-col max-sm:items-start">
      <div className="flex items-center gap-3">
        <KbdGroup className="items-center gap-1.5">
          <Kbd>
            <ArrowUp />
          </Kbd>
          <Kbd>
            <ArrowDown />
          </Kbd>
          <span>Navigate</span>
        </KbdGroup>
        <KbdGroup className="items-center gap-1.5">
          <Kbd>Enter</Kbd>
          <span>Open</span>
        </KbdGroup>
        <KbdGroup className="items-center gap-1.5">
          <Kbd>Esc</Kbd>
          <span>Close</span>
        </KbdGroup>
      </div>
    </CommandFooter>
  );
}

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;
  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of props.indices) {
    if (start < index) parts.push(props.value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-current" key={index}>
        {props.value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));
  return <>{parts}</>;
}

export function FileSearchDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [fileMask, setFileMask] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const result = useProjectPathSearch(
    {
      environmentId: props.open ? props.environmentId : null,
      cwd: props.open ? props.cwd : null,
      query,
      kind: "file",
      fileMask,
    },
    200,
    { allowEmptyQuery: true },
  );
  const files = useMemo(
    () => getFileSearchMatches(result.entries, result.searchedQuery),
    [result.entries, result.searchedQuery],
  );
  const hasSearchedQuery = /\S/u.test(result.searchedQuery);
  const selected = files[Math.min(selectedIndex, Math.max(0, files.length - 1))] ?? null;

  useEffect(() => setSelectedIndex(0), [fileMask, query]);
  useEffect(() => {
    if (props.open) return;
    setQuery("");
    setFileMask("");
    setSelectedIndex(0);
  }, [props.open]);

  const openSelected = () => {
    if (!selected) return;
    props.onOpenFile(selected.path);
    props.onOpenChange(false);
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label="Search files"
          className="h-[min(46rem,82vh)] w-[min(64rem,calc(100vw-2rem))] max-h-[82vh] max-w-none overflow-hidden p-0"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex((current) => Math.min(files.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              openSelected();
            }
          }}
        >
          <div className="flex size-full min-h-0 flex-col" data-testid="file-search-dialog">
            <SearchDialogHeader
              title="Search Files"
              summary={`${files.length}${files.length === 200 ? "+" : ""} files in ${props.projectName}`}
              query={query}
              fileMask={fileMask}
              queryPlaceholder="Search by file name or path…"
              onQueryChange={setQuery}
              onFileMaskChange={setFileMask}
            />
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(9rem,42%)_minmax(0,1fr)]">
              <div className="min-h-0 overflow-auto border-b border-border/60 p-2">
                {result.isPending && files.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading project files…
                  </div>
                ) : files.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No files match this search.
                  </div>
                ) : (
                  files.map((entry, index) => (
                    <button
                      key={entry.path}
                      type="button"
                      className={cn(
                        "flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-base sm:min-h-7 sm:text-sm",
                        index === selectedIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-foreground/[0.06]",
                      )}
                      onClick={() => setSelectedIndex(index)}
                      onDoubleClick={() => {
                        props.onOpenFile(entry.path);
                        props.onOpenChange(false);
                      }}
                    >
                      <FileIcon className="size-3.5 shrink-0 opacity-75" />
                      <span className="shrink-0 font-medium">
                        <HighlightedFuzzyText
                          active={hasSearchedQuery}
                          indices={entry.nameMatchIndices}
                          value={entry.name}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate opacity-65">
                        <HighlightedFuzzyText
                          active={hasSearchedQuery}
                          indices={entry.pathMatchIndices}
                          value={entry.path}
                        />
                      </span>
                    </button>
                  ))
                )}
              </div>
              <SearchFilePreview
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                relativePath={selected?.path ?? null}
                line={null}
                revealRequestId={selectedIndex + 1}
              />
            </div>
            <SearchDialogFooter />
          </div>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}

const CONTENT_SEARCH_VISIBLE_WINDOW = 100;
const CONTENT_SEARCH_RESULTS_ID = "project-text-search-results";

function contentSearchResultId(resultIndex: number): string {
  return `project-text-search-result-${resultIndex}`;
}

function formatContentSearchSummary(matchCount: number, fileCount: number, truncated: boolean) {
  const matches = matchCount === 1 ? "match" : "matches";
  const files = fileCount === 1 ? "file" : "files";
  return `${matchCount}${truncated ? "+" : ""} ${matches} in ${fileCount} ${files}`;
}

interface ContentSearchGroup {
  readonly path: string;
  readonly totalCount: number;
  readonly matches: ReadonlyArray<ProjectTextSearchMatch & { readonly resultIndex: number }>;
}

function groupContentMatches(
  matches: ReadonlyArray<ProjectTextSearchMatch>,
  visibleCount: number,
): ContentSearchGroup[] {
  const totals = new Map<string, number>();
  for (const match of matches) totals.set(match.path, (totals.get(match.path) ?? 0) + 1);
  const groups = new Map<
    string,
    Array<ProjectTextSearchMatch & { readonly resultIndex: number }>
  >();
  matches.slice(0, visibleCount).forEach((match, resultIndex) => {
    const indexed = { ...match, resultIndex };
    const group = groups.get(match.path);
    if (group) group.push(indexed);
    else groups.set(match.path, [indexed]);
  });
  return [...groups].map(([path, groupedMatches]) => ({
    path,
    totalCount: totals.get(path) ?? groupedMatches.length,
    matches: groupedMatches,
  }));
}

export function ProjectTextSearchDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string, line?: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [fileMask, setFileMask] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(CONTENT_SEARCH_VISIBLE_WINDOW);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const focusSelectedResultRef = useRef(false);
  const { resolvedTheme } = useTheme();
  const result = useProjectTextSearch({
    environmentId: props.open ? props.environmentId : null,
    threadId: props.open ? props.threadRef.threadId : null,
    cwd: props.open ? props.cwd : null,
    query,
    fileMask,
    caseSensitive,
    wholeWord,
    useRegex,
  });
  const groups = useMemo(
    () => groupContentMatches(result.matches, visibleCount),
    [result.matches, visibleCount],
  );
  const fileCount = useMemo(
    () => new Set(result.matches.map((match) => match.path)).size,
    [result.matches],
  );
  const resolvedSelectedIndex =
    result.matches.length === 0 ? null : Math.min(selectedIndex, result.matches.length - 1);
  const selected =
    resolvedSelectedIndex === null ? null : (result.matches[resolvedSelectedIndex] ?? null);
  const canOpenSelected = !result.isPending && !result.error && !result.regexFallbackError;

  useEffect(() => {
    focusSelectedResultRef.current = false;
    setSelectedIndex(0);
    setVisibleCount(CONTENT_SEARCH_VISIBLE_WINDOW);
  }, [caseSensitive, fileMask, query, useRegex, wholeWord]);
  useEffect(() => {
    if (selectedIndex >= visibleCount) {
      setVisibleCount(selectedIndex + CONTENT_SEARCH_VISIBLE_WINDOW);
      return;
    }
    const resultElement = searchRootRef.current?.querySelector<HTMLElement>(
      `[data-content-search-result="${selectedIndex}"]`,
    );
    resultElement?.scrollIntoView({ block: "nearest" });
    if (focusSelectedResultRef.current && resultElement) {
      focusSelectedResultRef.current = false;
      resultElement.focus();
    }
  }, [selectedIndex, visibleCount]);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => current + CONTENT_SEARCH_VISIBLE_WINDOW);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [groups]);
  useEffect(() => {
    if (props.open) return;
    setQuery("");
    setFileMask("");
    setCaseSensitive(false);
    setWholeWord(false);
    setUseRegex(false);
    setSelectedIndex(0);
  }, [props.open]);

  const openSelected = () => {
    if (!selected || !canOpenSelected) return;
    props.onOpenFile(selected.path, selected.lineNumber);
    props.onOpenChange(false);
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label="Find text in project"
          className="h-[min(46rem,82vh)] w-[min(64rem,calc(100vw-2rem))] max-h-[82vh] max-w-none overflow-hidden p-0"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (result.matches.length > 0) {
                const moveFocus =
                  event.target instanceof Element &&
                  event.target.closest("[data-content-search-result]") !== null;
                focusSelectedResultRef.current = moveFocus;
                setSelectedIndex((current) => {
                  const next = (current + 1) % result.matches.length;
                  return next;
                });
              }
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (result.matches.length > 0) {
                const moveFocus =
                  event.target instanceof Element &&
                  event.target.closest("[data-content-search-result]") !== null;
                focusSelectedResultRef.current = moveFocus;
                setSelectedIndex((current) => {
                  const next = (current - 1 + result.matches.length) % result.matches.length;
                  return next;
                });
              }
            } else if (event.key === "Enter") {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.target instanceof Element && event.target.closest("button")) return;
              event.preventDefault();
              openSelected();
            }
          }}
        >
          <div
            ref={searchRootRef}
            className="flex size-full min-h-0 flex-col"
            data-testid="project-text-search"
          >
            <SearchDialogHeader
              title="Find in Files"
              summary={
                query.length === 0
                  ? `Search ${props.projectName}`
                  : result.isPending
                    ? "Searching…"
                    : result.error
                      ? "Search failed"
                      : result.regexFallbackError
                        ? "Invalid regular expression"
                        : formatContentSearchSummary(
                            result.matches.length,
                            fileCount,
                            result.truncated,
                          )
              }
              summaryLive
              query={query}
              fileMask={fileMask}
              queryPlaceholder={`Find text in ${props.projectName}…`}
              queryTestId="project-text-search-input"
              {...(query.length > 0 && canOpenSelected && resolvedSelectedIndex !== null
                ? { queryActiveDescendant: contentSearchResultId(resolvedSelectedIndex) }
                : {})}
              queryControls={CONTENT_SEARCH_RESULTS_ID}
              queryOptions={
                <>
                  <Toggle
                    aria-label="Match case"
                    pressed={caseSensitive}
                    size="sm"
                    variant="ghost"
                    onPressedChange={setCaseSensitive}
                  >
                    <CaseSensitive className="size-3.5" />
                  </Toggle>
                  <Toggle
                    aria-label="Match whole word"
                    pressed={wholeWord}
                    size="sm"
                    variant="ghost"
                    onPressedChange={setWholeWord}
                  >
                    <WholeWord className="size-3.5" />
                  </Toggle>
                  <Toggle
                    aria-label="Use regular expression"
                    pressed={useRegex}
                    size="sm"
                    variant="ghost"
                    onPressedChange={setUseRegex}
                  >
                    <span className="font-mono text-xs">.*</span>
                  </Toggle>
                </>
              }
              onQueryChange={setQuery}
              onFileMaskChange={setFileMask}
            />
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,46%)_minmax(0,1fr)]">
              <div
                id={CONTENT_SEARCH_RESULTS_ID}
                className="min-h-0 overflow-auto border-b border-border/60 p-2"
              >
                {query.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Type to search project text.
                  </div>
                ) : result.error ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-destructive">
                    Project search failed.
                    <button type="button" onClick={result.restartSearch} className="underline">
                      Retry search
                    </button>
                  </div>
                ) : result.regexFallbackError ? (
                  <div className="flex h-full items-center justify-center text-xs text-destructive">
                    Invalid regular expression.
                  </div>
                ) : !result.isPending && result.matches.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No matches found.
                  </div>
                ) : (
                  <div role="listbox" aria-label="Search results">
                    {groups.map((group) => (
                      <section
                        aria-label={group.path}
                        className="pb-2"
                        key={group.path}
                        role="group"
                      >
                        <div className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-background/95 px-2 text-xs backdrop-blur-sm">
                          <FileIcon className="size-3.5 shrink-0 opacity-75" />
                          <span className="min-w-0 flex-1 truncate font-medium">{group.path}</span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-[10px] text-muted-foreground">
                            {group.totalCount}
                          </span>
                        </div>
                        {group.matches.map((match) => (
                          <button
                            key={`${match.path}:${match.lineNumber}:${match.resultIndex}`}
                            id={contentSearchResultId(match.resultIndex)}
                            type="button"
                            role="option"
                            data-content-search-result={match.resultIndex}
                            disabled={!canOpenSelected}
                            aria-current={
                              match.resultIndex === resolvedSelectedIndex ? "true" : undefined
                            }
                            aria-selected={match.resultIndex === resolvedSelectedIndex}
                            aria-label={`${group.path}, line ${match.lineNumber}: ${match.lineContent}`}
                            tabIndex={match.resultIndex === resolvedSelectedIndex ? 0 : -1}
                            className={cn(
                              "flex h-7 w-full min-w-0 items-center gap-3 rounded-sm px-2 text-left font-mono text-xs disabled:pointer-events-none",
                              match.resultIndex === resolvedSelectedIndex
                                ? "bg-accent text-accent-foreground [&_mark]:bg-foreground/15! [&_mark]:text-foreground!"
                                : "hover:bg-foreground/[0.06]",
                            )}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                              event.preventDefault();
                              event.stopPropagation();
                              if (!canOpenSelected) return;
                              props.onOpenFile(match.path, match.lineNumber);
                              props.onOpenChange(false);
                            }}
                            onFocus={() => setSelectedIndex(match.resultIndex)}
                            onClick={() => setSelectedIndex(match.resultIndex)}
                            onDoubleClick={() => {
                              if (!canOpenSelected) return;
                              props.onOpenFile(match.path, match.lineNumber);
                              props.onOpenChange(false);
                            }}
                          >
                            <span className="w-10 shrink-0 text-right tabular-nums opacity-65">
                              {match.lineNumber}
                            </span>
                            <span className="min-w-0 flex-1 truncate whitespace-pre">
                              <HighlightedSearchLine
                                match={match}
                                path={group.path}
                                theme={resolvedTheme}
                              />
                            </span>
                          </button>
                        ))}
                      </section>
                    ))}
                    {result.matches.length > visibleCount ? (
                      <div ref={loadMoreRef} className="h-8" aria-hidden="true" />
                    ) : null}
                  </div>
                )}
                {result.hasMore && (
                  <button
                    type="button"
                    disabled={result.isPending}
                    onClick={result.loadMore}
                    className="px-4 py-2 text-sm"
                  >
                    Load more matches
                  </button>
                )}
              </div>
              <SearchFilePreview
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                relativePath={selected?.path ?? null}
                line={selected?.lineNumber ?? null}
                revealRequestId={(resolvedSelectedIndex ?? 0) + 1}
              />
            </div>
            <SearchDialogFooter />
          </div>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
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
          const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
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
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
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
  const keybindings = useEnvironmentKeybindings(props.environmentId);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const file = useProjectFileQuery(
    props.environmentId,
    props.threadRef.threadId,
    props.cwd,
    props.relativePath,
  );
  useWorkspaceMutationRefresh({
    enabled: props.relativePath !== null && !props.selectedFilePending,
    mutationId: props.workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${props.environmentId}:${props.cwd}:${props.relativePath ?? ""}`,
  });
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [renderMarkdown, setRenderMarkdown] = useState(false);
  const [saveFailedPath, setSaveFailedPath] = useState<string | null>(null);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineInitialValue, setGoToLineInitialValue] = useState("1:1");
  const [findOpen, setFindOpen] = useState(false);
  const [findRequestId, setFindRequestId] = useState(0);
  const [findRevealLine, setFindRevealLine] = useState<number | null>(null);
  const [findRevealRequestId, setFindRevealRequestId] = useState(0);
  const lastFindMatchKeyRef = useRef<string | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const editorFindAvailable =
    props.relativePath !== null && file.data !== null && !file.data.truncated;
  const isMarkdown = props.relativePath ? isMarkdownPreviewFile(props.relativePath) : false;
  const breadcrumbs = useMemo(
    () => (props.relativePath ? fileBreadcrumbs(props.projectName, props.relativePath) : []),
    [props.projectName, props.relativePath],
  );
  const onPostRender = useFileLineReveal(
    props.relativePath,
    findOpen ? findRevealLine : props.revealLine,
    findOpen ? findRevealRequestId : props.revealRequestId,
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

  const openEditorFind = useCallback(() => {
    if (!props.relativePath || !file.data || file.data.truncated) return;
    if (renderMarkdown) setRenderMarkdown(false);
    setFindOpen(true);
    setFindRequestId((current) => current + 1);
  }, [file.data, props.relativePath, renderMarkdown]);

  const openGoToLine = useCallback(() => {
    let initialValue = "1:1";
    if (props.relativePath && file.data && !file.data.truncated) {
      const session = getFileEditorSession(
        {
          threadRef: props.threadRef,
          cwd: props.cwd,
          relativePath: props.relativePath,
        },
        file.data.contents,
        file.data.revision,
      );
      const position = session.editor.getState().selections?.[0]?.end;
      if (position) initialValue = `${position.line + 1}:${position.character + 1}`;
    }
    setGoToLineInitialValue(initialValue);
    setGoToLineOpen(true);
  }, [file.data, props.cwd, props.relativePath, props.threadRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture], [role='dialog']")
      ) {
        return;
      }
      const context = {
        terminalFocus: isTerminalFocused(),
        fileViewerOpen: true,
        fileViewerFocus: event
          .composedPath()
          .some(
            (target) => target instanceof Element && target.closest("[data-file-viewer]") !== null,
          ),
        fileOpen: props.relativePath !== null,
      };
      const command = resolveShortcutCommand(event, keybindings, { context });
      if (command !== "fileViewer.find" && command !== "fileViewer.goToLine") {
        return;
      }
      if (command === "fileViewer.find" && !editorFindAvailable) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "fileViewer.find") openEditorFind();
      else openGoToLine();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editorFindAvailable, keybindings, openEditorFind, openGoToLine, props.relativePath]);

  useEffect(() => {
    setFindOpen(false);
    setFindRevealLine(null);
    lastFindMatchKeyRef.current = null;
  }, [props.relativePath]);

  const revealFindMatch = useCallback(
    (match: FileTextMatch | null) => {
      if (!props.relativePath || !file.data || file.data.truncated) return;
      const matchKey = match
        ? `${match.start.line}:${match.start.character}:${match.end.line}:${match.end.character}`
        : null;
      if (lastFindMatchKeyRef.current === matchKey) return;
      lastFindMatchKeyRef.current = matchKey;
      const session = getFileEditorSession(
        {
          threadRef: props.threadRef,
          cwd: props.cwd,
          relativePath: props.relativePath,
        },
        file.data.contents,
        file.data.revision,
      );
      if (!match) {
        if (session.editor.getFile()) session.editor.setSelections([]);
        setFindRevealLine(null);
        return;
      }
      setFindRevealLine(match.start.line + 1);
      setFindRevealRequestId((current) => current + 1);
      const selectMatch = (attempt: number) => {
        requestAnimationFrame(() => {
          if (!session.editor.getFile()) {
            if (attempt < 10) selectMatch(attempt + 1);
            return;
          }
          session.editor.setSelections([{ ...match, direction: "none" }]);
        });
      };
      selectMatch(0);
    },
    [file.data, props.cwd, props.relativePath, props.threadRef],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    lastFindMatchKeyRef.current = null;
    if (!props.relativePath || !file.data || file.data.truncated) return;
    requestAnimationFrame(() => {
      getFileEditorSession(
        {
          threadRef: props.threadRef,
          cwd: props.cwd,
          relativePath: props.relativePath!,
        },
        file.data!.contents,
        file.data!.revision,
      ).editor.focus();
    });
  }, [file.data, props.cwd, props.relativePath, props.threadRef]);

  const goToLine = useCallback(
    (line: number, column: number) => {
      if (!props.relativePath || !file.data) return;
      const resolvedLine = clampFileLine(file.data.contents, line);
      props.onOpenFile(props.relativePath, resolvedLine);
      if (file.data.truncated) return;
      const lineText = file.data.contents.split(/\r\n|\r|\n/)[resolvedLine - 1] ?? "";
      const resolvedColumn = Math.min(Math.max(1, column), lineText.length + 1);
      requestAnimationFrame(() => {
        const session = getFileEditorSession(
          {
            threadRef: props.threadRef,
            cwd: props.cwd,
            relativePath: props.relativePath!,
          },
          file.data!.contents,
          file.data!.revision,
        );
        const position = { line: resolvedLine - 1, character: resolvedColumn - 1 };
        session.editor.setSelections([{ start: position, end: position, direction: "none" }]);
        session.editor.focus();
      });
    },
    [file.data, props.cwd, props.onOpenFile, props.relativePath, props.threadRef],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" data-file-viewer="">
      <GoToLineDialog
        open={goToLineOpen}
        initialValue={goToLineInitialValue}
        onOpenChange={setGoToLineOpen}
        onSubmit={goToLine}
      />
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
      {props.relativePath && file.data && !file.data.truncated ? (
        <FileFindBar
          open={findOpen}
          requestId={findRequestId}
          contents={file.data.contents}
          onClose={closeFind}
          onMatchChange={revealFindMatch}
        />
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
              // Markdown reconciles in place across text updates, so a file
              // switch needs a new key or the previous file's disclosure and
              // wrap state carries into the next document.
              <RenderedMarkdownSurface
                key={props.relativePath}
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
                    preferredHighlighter: PREFERRED_HIGHLIGHTER,
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
              workspaceMutationId={props.workspaceMutationId}
              {...(props.relativePath ? { onRefreshSelectedFile: file.refresh } : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function FileSearchDialogs(props: {
  commandRequest: FileSearchCommandRequest | null;
  onCommandRequestHandled: (id: number) => void;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string, line?: number) => void;
}) {
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  useEffect(() => {
    const request = props.commandRequest;
    if (!request) return;
    if (request.command === "projectSearch.toggle") setProjectSearchOpen(true);
    else setFileSearchOpen(true);
    props.onCommandRequestHandled(request.id);
  }, [props.commandRequest, props.onCommandRequestHandled]);

  return (
    <>
      <ProjectTextSearchDialog
        open={projectSearchOpen}
        onOpenChange={setProjectSearchOpen}
        environmentId={props.environmentId}
        threadRef={props.threadRef}
        cwd={props.cwd}
        projectName={props.projectName}
        onOpenFile={props.onOpenFile}
      />
      <FileSearchDialog
        open={fileSearchOpen}
        onOpenChange={setFileSearchOpen}
        environmentId={props.environmentId}
        threadRef={props.threadRef}
        cwd={props.cwd}
        projectName={props.projectName}
        onOpenFile={props.onOpenFile}
      />
    </>
  );
}
