import type { EnvironmentId, ProjectEntry, ThreadId } from "@t3tools/contracts";
import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
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

export function contextMenuFilePath(
  item: Pick<ContextMenuItem, "kind" | "path">,
  entryKinds: ReadonlyMap<string, ProjectEntry["kind"]>,
): string | null {
  const path = item.path.replace(/\/$/, "");
  if (
    item.kind !== "file" ||
    entryKinds.get(path) !== "file" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
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
  workspaceMutationId: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const { copyToClipboard } = useCopyToClipboard({ target: "project-relative path" });
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.threadId, props.cwd);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    refresh: entriesQuery.refresh,
    resourceKey: `files:${props.environmentId}:${props.cwd}`,
  });
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
      };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);
  const showEntryContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const relativePath = contextMenuFilePath(item, entryKindsRef.current);
      const localApi = readLocalApi();
      if (!relativePath || !localApi) {
        context.close();
        return;
      }
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1_000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      void localApi.contextMenu
        .show([{ id: "copy-path", label: "Copy path", icon: "copy" }], position)
        .then((action) => {
          if (action === "copy-path") copyToClipboard(relativePath, undefined);
        })
        .catch(() => undefined)
        .finally(() => context.close());
    },
    [copyToClipboard],
  );

  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: showEntryContextMenu,
      },
    },
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
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );
  const toggleAllDirectories = () => {
    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded);
  };
  const hasNoSearchMatches =
    search.isOpen && search.value.trim().length > 0 && search.matchingPaths.length === 0;

  useEffect(() => {
    if (entriesQuery.data === null) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [entriesQuery.data, entryKinds, model, treePaths]);

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
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
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
