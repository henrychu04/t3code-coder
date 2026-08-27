import type { EnvironmentId, ProjectEntry, ThreadId } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { RotateCw } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export function filePathFromTreeContextMenu(
  eventPath: readonly EventTarget[],
  entryKinds: ReadonlyMap<string, ProjectEntry["kind"]>,
): string | null {
  const row = eventPath.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement && target.dataset.itemPath !== undefined,
  );
  const relativePath = row?.dataset.itemPath?.replace(/\/$/, "");
  return relativePath && entryKinds.get(relativePath) === "file" ? relativePath : null;
}

export default function FileBrowserPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const { copyToClipboard } = useCopyToClipboard({ target: "project-relative path" });
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.threadId, props.cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        props.onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const hasNoSearchMatches =
    search.isOpen && search.value.trim().length > 0 && search.matchingPaths.length === 0;

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    const selectedPath = props.selectedPath;
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const request = { path: selectedPath, revealId: props.selectedPathRevealId };
    if (
      handledRevealRef.current?.path === request.path &&
      handledRevealRef.current.revealId === request.revealId
    ) {
      return;
    }
    if (entryKinds.get(selectedPath) !== "file") return;
    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;
    handledRevealRef.current = request;
    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }
    selectedItem.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, props.selectedPath, props.selectedPathRevealId, treePaths]);

  const refresh = () => {
    entriesQuery.refresh();
    props.onRefreshSelectedFile?.();
  };

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const relativePath = filePathFromTreeContextMenu(
        event.nativeEvent.composedPath(),
        entryKindsRef.current,
      );
      if (!relativePath) return;

      const localApi = readLocalApi();
      if (!localApi) return;
      event.preventDefault();
      event.stopPropagation();
      void localApi.contextMenu
        .show([{ id: "copy-path", label: "Copy path", icon: "copy" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "copy-path") copyToClipboard(relativePath, undefined);
        });
    },
    [copyToClipboard],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh workspace files"
                onClick={refresh}
              />
            }
          >
            <RotateCw className={cn(entriesQuery.isPending && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup>{entriesQuery.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
        </Tooltip>
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
          <InputGroupInput
            type="search"
            name="project-files-search"
            size="sm"
            value={search.value}
            aria-label={`Search ${props.projectName} files`}
            placeholder="Search files"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              if (value.trim().length === 0) search.close();
              else search.setValue(value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              search.close();
              event.currentTarget.blur();
            }}
          />
        </InputGroup>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs text-destructive">{entriesQuery.error}</div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <FileTree
            model={model}
            aria-label={`${props.projectName} files`}
            aria-hidden={hasNoSearchMatches || undefined}
            className={cn("size-full overflow-hidden", hasNoSearchMatches && "invisible")}
            onContextMenu={handleContextMenu}
            style={{
              colorScheme: resolvedTheme,
              ["--trees-fg-override" as string]: "var(--contrast-foreground)",
            }}
          />
          {hasNoSearchMatches ? (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
              No files match your search.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
