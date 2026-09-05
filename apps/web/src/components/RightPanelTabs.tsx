import type { PullRequestState } from "@t3tools/contracts";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  Files,
  GitPullRequest,
  Plus,
  TerminalSquare,
} from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useResizableWidth } from "../hooks/useResizableWidth";
import { useTheme } from "../hooks/useTheme";
import type { ContextMenuItem } from "../localApiTypes";
import { readLocalApi } from "../localApi";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  resolveRightPanelWidths,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "../rightPanelLayout";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { PanelTabCloseButton } from "./ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

interface RightPanelTabsProps {
  readonly mode: "inline" | "sheet";
  readonly maximized?: boolean;
  readonly widthStorageKey?: string;
  readonly defaultWidth?: number;
  readonly layoutControls?: ReactNode;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  readonly onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  readonly onCloseAllSurfaces: () => void;
  readonly onCopyFilePath: (relativePath: string) => void;
  readonly onAddBrowser?: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddFiles: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddAgents: () => void;
  readonly terminalAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly filesAvailable: boolean;
  readonly pullRequestAvailable: boolean;
  readonly agentsAvailable: boolean;
  readonly browserAvailable?: boolean;
  readonly previewSessions?: Readonly<Record<string, unknown>>;
  readonly desktopByTabId?: Readonly<Record<string, unknown>>;
  readonly pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>>;
  readonly liveAgentCount: number;
  readonly children: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "GitLab merge requests are only available from GitLab project threads.",
  agents: "Agents are only available from a thread.",
} as const;

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const SURFACE_UNAVAILABLE_HINTS = {
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "Available for GitLab project threads.",
  agents: "Available from a thread.",
} as const;

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}

export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

export function rightPanelTabContextMenuItems(
  surfaces: readonly RightPanelSurface[],
  surface: RightPanelSurface,
): readonly ContextMenuItem<TabContextMenuAction>[] {
  const surfaceIndex = surfaces.findIndex((entry) => entry.id === surface.id);
  if (surfaceIndex < 0) return [];

  return [
    ...(surface.kind === "file" ? [{ id: "copy-path" as const, label: "Copy path" }] : []),
    { id: "close", label: "Close" },
    {
      id: "close-others",
      label: "Close others",
      disabled: surfaces.length <= 1,
    },
    {
      id: "close-to-right",
      label: "Close to the right",
      disabled: surfaceIndex >= surfaces.length - 1,
    },
    {
      id: "close-all",
      label: "Close all",
      disabled: surfaces.length === 0,
    },
  ];
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
}) {
  const [highlight, setHighlight] = useState(-1);

  const actions = [
    {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.terminal,
      onClick: props.onAddTerminal,
      badgeCount: 0,
    },
    {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      label: "GitLab MR",
      description: "View the current GitLab merge request.",
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
      badgeCount: 0,
    },
    {
      label: "Agents",
      description: "Follow subagents and workflows.",
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.agents,
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  const shortcutActionsRef = useRef(availableActions);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = surfaceShortcutActionForKey(shortcutActionsRef.current, event);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction) => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className="size-4" />
        {action.badgeCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
          >
            {action.badgeCount}
          </span>
        ) : null}
      </span>
    );
  };

  const cardShellClass =
    "rounded-lg border border-border/80 bg-card dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5";
  const highlightedCardClass = "bg-accent/60 dark:inset-ring-white/20";

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        "pb-[calc(var(--workspace-topbar-height)+--spacing(6))]",
      )}
    >
      <div className="relative w-full max-w-lg">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">Open a surface</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
                className={cn(
                  "relative flex min-w-0 w-full cursor-pointer flex-col items-start p-4 text-left transition hover:border-border hover:bg-accent/60",
                  cardShellClass,
                  isHighlighted(action) && highlightedCardClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.description}
                </span>
              </button>
            ) : (
              <div
                key={action.label}
                className={cn(
                  "relative flex min-w-0 w-full flex-col items-start p-4 opacity-40",
                  cardShellClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.disabledReason}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function surfaceLabel(
  surface: RightPanelSurface,
  terminalLabels: ReadonlyMap<string, string>,
): string {
  if (surface.kind === "diff") return "Diff";
  if (surface.kind === "files") return "Files";
  if (surface.kind === "file")
    return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
  if (surface.kind === "pull-request")
    return "number" in surface ? `MR !${surface.number}` : "GitLab MR";
  if (surface.kind === "agents") return "Agents";
  return terminalLabels.get(surface.activeTerminalId) ?? "Terminal";
}

function SurfaceIcon({
  surface,
  theme,
  pullRequestStatuses,
}: {
  readonly surface: RightPanelSurface;
  readonly theme: "light" | "dark";
  readonly pullRequestStatuses: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  if (surface.kind === "diff") return <FileDiff className="size-3.5" />;
  if (surface.kind === "files") return <Files className="size-3.5" />;
  if (surface.kind === "file") {
    return (
      <PierreEntryIcon
        pathValue={surface.relativePath}
        kind="file"
        theme={theme}
        className="size-3.5"
      />
    );
  }
  if (surface.kind === "pull-request") {
    const status = pullRequestStatuses?.[surface.id] ?? null;
    const toneClassName =
      status?.state === "merged"
        ? "text-violet-600 dark:text-violet-300/90"
        : status?.state === "closed"
          ? "text-red-600 dark:text-red-300/90"
          : status?.isDraft
            ? "text-zinc-500 dark:text-zinc-400/80"
            : status?.state === "open"
              ? "text-emerald-600 dark:text-emerald-300/90"
              : "text-muted-foreground";
    return <GitPullRequest className={cn("size-3.5", toneClassName)} />;
  }
  if (surface.kind === "agents") return <Bot className="size-3.5" />;
  return <TerminalSquare className="size-3.5" />;
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const { resolvedTheme } = useTheme();
  const resizable = props.mode === "inline" && !props.maximized;
  const hostRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const updateTabScrollState = useCallback(() => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) =>
      current.hasOverflow === hasOverflow &&
      current.canScrollLeft === canScrollLeft &&
      current.canScrollRight === canScrollRight
        ? current
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  }, []);
  const scrollTabs = useCallback((direction: -1 | 1) => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);
  const { defaultWidth, maxWidth } = useClampedRightPanelWidths(hostRef, resizable);
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? RIGHT_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? defaultWidth,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  const addSurfaceActions = [
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "GitLab MR",
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Agents",
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: props.onAddAgents,
    },
  ] as const;

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      const api = readLocalApi();
      if (!api) return;

      const items = rightPanelTabContextMenuItems(props.surfaces, surface);
      if (items.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    if (!props.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const active = tabsRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, tabScrollState.hasOverflow]);

  useLayoutEffect(() => {
    updateTabScrollState();
  }, [props.surfaces, updateTabScrollState]);

  useEffect(() => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    const resizeObserver = new ResizeObserver(updateTabScrollState);
    resizeObserver.observe(viewport);
    viewport.addEventListener("scroll", updateTabScrollState, { passive: true });
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateTabScrollState);
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;
      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      updateTabScrollState();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [updateTabScrollState]);

  return (
    <section
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col border-l border-border bg-background",
        props.mode === "inline" && (props.maximized ? "w-full" : "shrink-0"),
        props.mode === "sheet" && "w-full",
      )}
      style={resizable ? { width: `${width}px` } : undefined}
    >
      {resizable ? (
        <div
          role="separator"
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          title="Drag to resize right panel"
          className="group absolute inset-y-0 -left-1 z-40 w-2 cursor-col-resize touch-none select-none"
          {...handlers}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
          />
        </div>
      ) : null}
      <header
        className={cn(
          "flex h-11 shrink-0 items-center gap-1 border-b border-border pl-2",
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-2",
        )}
      >
        <div ref={tabsRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            const pending = props.pendingSurfaceIds.has(surface.id);
            const title = surfaceLabel(surface, props.terminalLabelsById);
            return (
              <div
                key={surface.id}
                data-active-tab={active}
                onMouseDown={handleTabMouseDown}
                onAuxClick={(event) => handleTabAuxClick(event, surface)}
                onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                className={cn(
                  "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <PanelTabCloseButton
                  label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <SurfaceIcon
                    surface={surface}
                    theme={resolvedTheme}
                    pullRequestStatuses={props.pullRequestStatuses}
                  />
                  {pending ? (
                    <span
                      className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                      aria-hidden
                    />
                  ) : null}
                </PanelTabCloseButton>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="cursor-pointer flex min-w-0 items-center"
                        onClick={() => props.onActivate(surface)}
                      >
                        <span className="truncate">{title}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{title}</TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
          {props.surfaces.length > 0 ? (
            <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
              <MenuTrigger
                render={
                  <Button
                    aria-label="Add panel surface"
                    className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              >
                <Plus className="size-3.5" />
              </MenuTrigger>
              <MenuPopup
                align="start"
                side="bottom"
                sideOffset={6}
                className="min-w-44"
                onKeyDownCapture={handleAddSurfaceMenuKeyDown}
              >
                {addSurfaceActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <SurfaceMenuItem
                      key={action.label}
                      available={action.available}
                      disabledReason={action.disabledReason}
                      shortcut={action.shortcut}
                      onClick={action.onClick}
                    >
                      <Icon />
                      {action.label}
                    </SurfaceMenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {tabScrollState.hasOverflow ? (
          <div
            className="flex shrink-0 items-center gap-0.5"
            role="group"
            aria-label="Scroll panel tabs"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs left"
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeft />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs right"
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {props.layoutControls}
      </header>

      {props.activeSurfaceId === null ? (
        <RightPanelEmptyState
          onAddTerminal={props.onAddTerminal}
          onAddDiff={props.onAddDiff}
          onAddFiles={props.onAddFiles}
          onAddPullRequest={props.onAddPullRequest}
          onAddAgents={props.onAddAgents}
          terminalAvailable={props.terminalAvailable}
          diffAvailable={props.diffAvailable}
          filesAvailable={props.filesAvailable}
          pullRequestAvailable={props.pullRequestAvailable}
          agentsAvailable={props.agentsAvailable}
          liveAgentCount={props.liveAgentCount}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      )}
    </section>
  );
}

function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setViewportWidth(window.innerWidth);
      });
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return viewportWidth;
}

function useClampedRightPanelWidths(
  hostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): ReturnType<typeof resolveRightPanelWidths> {
  const viewportWidth = useViewportWidth();
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;

    const measure = () => {
      setContainerWidth(parent.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [enabled, hostRef]);

  return resolveRightPanelWidths(viewportWidth, containerWidth);
}
