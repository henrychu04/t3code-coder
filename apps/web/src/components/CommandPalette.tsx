import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import type { SearchOverlayMode } from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { readPullRequestListPreferences } from "./pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { FolderIcon } from "lucide-react";
import { sortThreads } from "~/lib/threadSort";
import { buildRootGroups } from "./CommandPalette.logic";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { MonitorIcon, MoonIcon, SunIcon, PaletteIcon } from "lucide-react";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { useRightPanelStore } from "../rightPanelStore";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { toastManager } from "./ui/toast";
import { PULL_REQUESTS_PANEL_REF } from "../rightPanelStore";
import { CoderAddProjectDialog } from "../coder/CoderAddProjectDialog";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useLocation } from "@tanstack/react-router";
import {
  FileIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { onOpenCommandPalette, type CommandPaletteOpenDetail } from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { resolveShortcutCommand } from "../keybindings";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import { useEnvironmentKeybindings, useEnvironments } from "../state/environments";
import { useActiveEnvironmentId, useProjects, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { ProjectFavicon } from "./ProjectFavicon";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add({
    type: "error",
    title: "Couldn't save theme selection",
    description: "Try again.",
  });
}

export function CommandPalette({ children }: { readonly children: ReactNode }) {
  const { appearanceMode, setAppearanceMode, theme, themeHalves, resolvedTheme } = useTheme();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const [openDetail, setOpenDetail] = useState<CommandPaletteOpenDetail>({});
  const keybindings = useEnvironmentKeybindings(useActiveEnvironmentId());
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        setOpenDetail(detail);
        if (detail.open === "change-theme") {
          dispatch({ _tag: "OpenChangeTheme" });
        } else if (detail.open === "new-thread-in") {
          dispatch({ _tag: "OpenNewThreadIn" });
        } else if (detail.open === "add-project") {
          dispatch({ _tag: "OpenAddProject" });
        } else {
          dispatch({ _tag: "OpenCommand" });
        }
      }),
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat)
          toggleThemeEditorForTheme({ theme, themeHalves, initialAppearance: resolvedTheme });
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      const mode =
        command === "commandPalette.toggle"
          ? "command"
          : command === "filePicker.toggle"
            ? "files"
            : command === "projectSearch.toggle"
              ? "content"
              : null;
      if (!mode) return;
      event.preventDefault();
      event.stopPropagation();
      setOpenDetail({});
      if (!event.repeat) dispatch({ _tag: "ToggleMode", mode });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, appearanceMode, setAppearanceMode, theme, themeHalves, resolvedTheme]);

  const addProjectOpen = state.open && state.openIntent?.kind === "add-project";
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={state.open && !addProjectOpen} onOpenChange={setOpen}>
        {children}
        {state.open && !addProjectOpen ? (
          <CommandDialogPopup
            aria-label={
              state.mode === "files"
                ? "File picker"
                : state.mode === "content"
                  ? "Search project contents"
                  : "Command palette"
            }
            className={
              state.mode === "content"
                ? "flex h-[min(44rem,80vh)] flex-col overflow-hidden p-0"
                : "overflow-hidden p-0"
            }
            data-command-palette="true"
            finalFocus={() => {
              composerHandleRef.current?.focusAtEnd();
              return false;
            }}
            onBackdropPointerDown={() => setOpen(false)}
          >
            {state.mode === "files" ? (
              <ProjectFilePicker setOpen={setOpen} />
            ) : state.mode === "content" ? (
              <ProjectContentSearchDialog onOpenChange={setOpen} />
            ) : (
              <CoderCommandPaletteDialog
                setMode={(mode) => dispatch({ _tag: "ToggleMode", mode })}
                clearOpenIntent={() => dispatch({ _tag: "ClearOpenIntent" })}
                openAddProject={() => dispatch({ _tag: "OpenAddProject" })}
                openDetail={openDetail}
                openIntent={state.openIntent}
                setOpen={setOpen}
              />
            )}
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
      {addProjectOpen ? <CoderAddProjectDialog onClose={() => setOpen(false)} /> : null}
    </ComposerHandleContext>
  );
}

function CoderCommandPaletteDialog(props: {
  readonly setMode: (mode: SearchOverlayMode) => void;
  readonly openDetail: CommandPaletteOpenDetail;
  readonly clearOpenIntent: () => void;
  readonly openAddProject: () => void;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const activeEnvironmentId = useActiveEnvironmentId();
  const keybindings = useEnvironmentKeybindings(activeEnvironmentId);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const threadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const pathname = useLocation({ select: (location) => location.pathname });
  const referenceThreadRef =
    pathname === "/pull-requests"
      ? environments.some(
          (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
        )
        ? PULL_REQUESTS_PANEL_REF
        : null
      : activeThread
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(referenceThreadRef);
  const referenceCopyTarget =
    referenceThreadRef === null || (pathname === "/pull-requests" && !openPanelPullRequestUrl)
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: referenceThreadRef.threadId,
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
        });
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const themeCards = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
  }, [customThemes, environmentThemes]);
  const [viewStack, setViewStack] = useState<
    ReadonlyArray<{
      value: string;
      groups: ReadonlyArray<CommandPaletteGroup>;
      parentQuery: string;
    }>
  >([]);
  const view = viewStack.at(-1)?.value ?? "root";
  const [query, setQuery] = useState(props.openDetail.query ?? "");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);

  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const messageSearch = useThreadSearch(environmentIds, view === "root" ? query : "");
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: groupingSettings,
        preferredEnvironmentId: activeEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [activeEnvironmentId, environmentLabelById, groupingSettings, projects],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
      }),
    [contextualProjectRef, projectGroups],
  );
  const projectItems = useMemo<CommandPaletteActionItem[]>(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        kind: "action",
        value: `new-thread-in:${targetProject.environmentId}:${targetProject.id}`,
        searchTerms: [
          group.displayName,
          ...group.memberProjects.flatMap((project) => [
            project.title,
            project.workspaceRoot,
            environments.find((environment) => environment.environmentId === project.environmentId)
              ?.label ?? project.environmentId,
          ]),
        ],
        title: group.displayName,
        description: [targetProject.workspaceRoot, targetProject.environmentLabel]
          .filter(Boolean)
          .join(" · "),
        icon: <ProjectFavicon project={targetProject} className="size-4 shrink-0" />,
        run: async () => {
          await handleNewThread(scopeProjectRef(targetProject.environmentId, targetProject.id));
        },
      })),
    [handleNewThread, projectPickerEntries, environments],
  );
  const availableSettingsItems = useAvailableSettingsSearchItems();
  const settingsItems = useMemo<CommandPaletteActionItem[]>(
    () =>
      availableSettingsItems.map((item) => ({
        kind: "action",
        value: `setting:${item.id}`,
        searchTerms: [item.title, item.section, ...item.searchTerms],
        title: item.title,
        description: item.section,
        ...(item.secondary === undefined ? {} : { secondary: item.secondary }),
        icon: <SettingsIcon className="size-4 shrink-0 text-icon-muted" />,
        run: async () => {
          await navigate({
            to: item.to,
            hash: item.targetId ?? item.id,
            hashScrollIntoView: false,
            state: { settingsTargetHighlight: true },
          });
        },
      })),
    [navigate, availableSettingsItems],
  );
  const projectViewGroups = useMemo<CommandPaletteGroup[]>(
    () =>
      projectItems.length > 0
        ? [{ value: "projects", label: "Projects", items: projectItems }]
        : [],
    [projectItems],
  );

  const projectByRef = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const messageMatchByThreadKey = new Map(
    messageSearch.matches.map((match) => [`${match.environmentId}:${match.threadId}`, match]),
  );
  const sortedThreads = sortThreads(
    threads.filter((thread) => thread.archivedAt === null),
    threadSortOrder,
  );
  const visibleThreads = query.trim().length > 0 ? sortedThreads : sortedThreads.slice(0, 12);
  const threadItems: CommandPaletteActionItem[] = visibleThreads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => {
      const match = messageMatchByThreadKey.get(`${thread.environmentId}:${thread.id}`);
      const project = projectByRef.get(`${thread.environmentId}:${thread.projectId}`);
      const projectTitle = project?.title ?? "Unknown project";
      return {
        kind: "action",
        value: `thread:${thread.environmentId}:${thread.id}`,
        searchTerms: [
          thread.title,
          projectTitle,
          environments.find((environment) => environment.environmentId === thread.environmentId)
            ?.label ?? thread.environmentId,
          thread.branch ?? "",
          match?.snippet ?? "",
          ...threadPullRequestSearchTerms(thread),
          thread.id,
        ],
        title: thread.title,
        titleLeadingContent: <ThreadRowLeadingStatus thread={thread} />,
        titleTrailingContent: <ThreadRowTrailingStatus thread={thread} />,
        description: (
          <ThreadCommandSubtitle
            project={project ?? null}
            projectTitle={projectTitle}
            environmentLabel={
              environments.find((environment) => environment.environmentId === thread.environmentId)
                ?.label ?? thread.environmentId
            }
            branch={thread.branch ?? null}
            worktreePath={thread.worktreePath ?? null}
            isCurrent={
              activeThread?.environmentId === thread.environmentId && activeThread.id === thread.id
            }
            variant="favicon-workspace"
          />
        ),
        ...(match
          ? {
              threadContentMatch: {
                source: match.source,
                snippet: match.snippet,
                query,
              },
            }
          : {}),
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: <MessageSquareIcon className="size-4 shrink-0 text-icon-muted" />,
        run: async () => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      };
    });
  if (props.openDetail.linkedThreads && query === props.openDetail.query) {
    threadItems.splice(
      0,
      threadItems.length,
      ...props.openDetail.linkedThreads.threads.map(
        (thread): CommandPaletteActionItem => ({
          kind: "action",
          value: `linked-thread:${thread.id}`,
          title: thread.title || "Untitled thread",
          description: thread.archivedAt === null ? "Linked thread" : "Archived thread",
          icon: <MessageSquareIcon className="size-4" />,
          searchTerms: [query],
          run: async () => {
            await navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(props.openDetail.linkedThreads!.environmentId, thread.id),
              ),
            });
          },
        }),
      ),
    );
  }
  const preferredProject =
    projectPickerEntries.find((entry) => entry.isPreferred) ?? projectPickerEntries[0];
  const projectSearchAvailable =
    activeThread !== null &&
    projects.some(
      (project) =>
        project.environmentId === activeThread.environmentId &&
        project.id === activeThread.projectId,
    );
  const projectSearchUnavailableDescription = "Open a project to search its files.";
  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  if (preferredProject) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread",
      searchTerms: ["new thread", "chat", "create", preferredProject.group.displayName],
      title: (
        <>
          New thread in <span className="font-semibold">{preferredProject.group.displayName}</span>
        </>
      ),
      icon: <SquarePenIcon className="size-4 text-icon-muted" />,
      shortcutCommand: "chat.newLocal",
      run: async () => {
        await startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
      },
    });
  }
  if (projectItems.length > 0) {
    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in…",
      icon: <SquarePenIcon className="size-4 text-icon-muted" />,
      groups: projectViewGroups,
    });
  }
  actionItems.push(
    {
      kind: "action",
      value: "action:find-files",
      searchTerms: ["find files", "search files", "project files"],
      title: "Search project files",
      description: projectSearchAvailable ? undefined : projectSearchUnavailableDescription,
      icon: <FileIcon className="size-4 text-icon-muted" />,
      disabled: !projectSearchAvailable,
      shortcutCommand: "filePicker.toggle",
      keepOpen: true,
      run: async () => props.setMode("files"),
    },
    {
      kind: "action",
      value: "action:find-project-contents",
      searchTerms: ["find text", "search project contents", "find in files"],
      title: "Search project contents",
      description: projectSearchAvailable ? undefined : projectSearchUnavailableDescription,
      icon: <SearchIcon className="size-4 text-icon-muted" />,
      disabled: !projectSearchAvailable,
      shortcutCommand: "projectSearch.toggle",
      keepOpen: true,
      run: async () => props.setMode("content"),
    },
    {
      kind: "action",
      value: "action:add-project",
      searchTerms: ["add project", "folder", "workspace"],
      title: "Add project",
      icon: <FolderPlusIcon className="size-4 text-icon-muted" />,
      keepOpen: true,
      run: async () => props.openAddProject(),
    },
  );

  if (referenceCopyTarget)
    actionItems.push({
      kind: "action",
      value: "action:copy-reference",
      title:
        referenceCopyTarget.kind === "pull-request"
          ? "Copy merge request link"
          : "Copy thread reference",
      searchTerms: ["copy", "reference", "merge request", "link"],
      shortcutCommand: "thread.copyReference",
      icon: <FileIcon className="size-4 text-icon-muted" />,
      run: async () => {
        try {
          const didCopy = await writeTextToClipboard(
            referenceCopyTarget.value,
            referenceCopyTarget.clipboardTarget,
          );
          if (didCopy)
            toastManager.add({
              type: "success",
              title: referenceCopyTarget.successTitle,
              description: referenceCopyTarget.value,
            });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy reference",
            description: error instanceof Error ? error.message : "Clipboard unavailable.",
          });
        }
      },
    });
  if (activeThread !== null) {
    const ref = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push(
      {
        kind: "action",
        value: "action:link-mr",
        icon: <MessageSquareIcon className="size-4" />,
        title: "Link merge request to thread",
        searchTerms: ["link", "mr", "merge request"],
        run: async () => {
          openLinkPullRequestDialog(ref);
        },
      },
      {
        kind: "action",
        value: "action:linked-mrs",
        icon: <MessageSquareIcon className="size-4" />,
        title: "Show linked merge requests",
        disabled: visibleThreadPullRequests(activeThread.pullRequests).length === 0,
        searchTerms: ["linked", "mr", "merge requests"],
        run: async () => {
          useRightPanelStore.getState().open(ref, "pull-requests");
        },
      },
    );
  }

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={"size-4 shrink-0"} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={"size-4 shrink-0"} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeThemeItem);

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={"size-4 shrink-0"} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={"size-4 shrink-0"} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeAppearanceItem);

  actionItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={"size-4 text-icon-muted"} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  if (
    environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    )
  ) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: ["merge requests", "mrs", "mr", "gitlab", "review", "merge", "branch"],
      title: "Open merge requests",
      icon: <PullRequestGlyph.pullRequest className={"size-4 text-icon-muted"} />,
      run: async () => {
        await navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={"size-4 text-icon-muted"} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // Target the active thread or draft's project, falling back to the first sidebar group.
  const contextualProjectGroup =
    (contextualProjectRef
      ? projectGroups.find((group) =>
          group.memberProjects.some(
            (project) =>
              project.environmentId === contextualProjectRef.environmentId &&
              project.id === contextualProjectRef.projectId,
          ),
        )
      : undefined) ?? projectGroups[0];
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "t3.json",
      ],
      title: "Project settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={"size-4 text-icon-muted"} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems: threadItems });
  useLayoutEffect(() => {
    const kind = props.openIntent?.kind;
    if (kind !== "change-theme" && kind !== "new-thread-in") return;
    setViewStack([
      {
        value: kind === "change-theme" ? "action:change-theme" : "action:new-thread-in",
        groups: kind === "change-theme" ? changeThemeItem.groups : projectViewGroups,
        parentQuery: "",
      },
    ]);
    setQuery("");
    props.clearOpenIntent();
  }, [props.openIntent, props.clearOpenIntent, changeThemeItem.groups, projectViewGroups]);
  const activeGroups = viewStack.at(-1)?.groups ?? rootGroups;
  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query,
    isInSubmenu: view !== "root",
    projectSearchItems: projectItems,
    settingsSearchItems: settingsItems,
    threadSearchItems: threadItems,
  });

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
    if (item.kind === "submenu") {
      setViewStack((stack) => [
        ...stack,
        { value: item.value, groups: item.groups, parentQuery: query },
      ]);
      setQuery("");
      setHighlightedItemValue(null);
      return;
    }
    if (!item.keepOpen) props.setOpen(false);
    void item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to run command",
        description: error instanceof Error ? error.message : "Try again.",
      });
    });
  };

  return (
    <CommandPaletteContent
      key={view}
      autoHighlight="always"
      escapeLabel={view !== "root" ? "Back" : "Close"}
      footerActionLabel={view === "action:new-thread-in" ? "Start thread" : "Open"}
      inputProps={{
        placeholder:
          view === "action:change-theme"
            ? "Choose a theme…"
            : view === "action:change-appearance"
              ? "Choose appearance…"
              : view === "action:new-thread-in"
                ? "Choose a project…"
                : "Search commands and threads…",
        onKeyDown: (event) => {
          if (
            (event.key === "Escape" || event.key === "Backspace") &&
            view !== "root" &&
            query.length === 0
          ) {
            event.preventDefault();
            event.stopPropagation();
            setQuery(viewStack.at(-1)?.parentQuery ?? "");
            setViewStack((stack) => stack.slice(0, -1));
          }
        },
      }}
      mode="none"
      onItemHighlighted={(value) =>
        setHighlightedItemValue(typeof value === "string" ? value : null)
      }
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(34rem,76vh)]"
      showBackHint={view !== "root"}
      testId="command-palette"
      value={query}
    >
      <CommandPaletteResults
        isActionsOnly={query.trimStart().startsWith(">")}
        groups={filteredGroups}
        highlightedItemValue={highlightedItemValue}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(messageSearch.isPending ? { emptyStateMessage: "Searching threads…" } : {})}
      />
    </CommandPaletteContent>
  );
}
