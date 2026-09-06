import { CoderAddProjectDialog } from "../coder/CoderAddProjectDialog";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
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

import { onOpenCommandPalette } from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { openFileViewerCommand } from "../fileViewerCommandBus";
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
import { SETTINGS_SEARCH_ITEMS } from "./settings/settingsSearch";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";

export function CommandPalette({ children }: { readonly children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const keybindings = useEnvironmentKeybindings(useActiveEnvironmentId());
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          dispatch({ _tag: "OpenNewThreadIn" });
        } else if (detail.open === "add-project") {
          dispatch({ _tag: "OpenAddProject" });
        } else {
          dispatch({ _tag: "SetOpen", open: true });
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
      if (command !== "commandPalette.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ _tag: "ToggleMode", mode: "command" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  const addProjectOpen = state.open && state.openIntent?.kind === "add-project";
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={state.open && !addProjectOpen} onOpenChange={setOpen}>
        {children}
        {state.open && !addProjectOpen ? (
          <CommandDialogPopup
            aria-label="Command palette"
            className="overflow-hidden p-0"
            data-command-palette="true"
            finalFocus={() => {
              composerHandleRef.current?.focusAtEnd();
              return false;
            }}
            onBackdropPointerDown={() => setOpen(false)}
          >
            <CoderCommandPaletteDialog
              clearOpenIntent={() => dispatch({ _tag: "ClearOpenIntent" })}
              openAddProject={() => dispatch({ _tag: "OpenAddProject" })}
              openIntent={state.openIntent}
              setOpen={setOpen}
            />
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
      {addProjectOpen ? <CoderAddProjectDialog onClose={() => setOpen(false)} /> : null}
    </ComposerHandleContext>
  );
}

function CoderCommandPaletteDialog(props: {
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
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const [view, setView] = useState<"root" | "projects">("root");
  const [query, setQuery] = useState("");
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
          ...group.memberProjects.flatMap((project) => [project.title, project.workspaceRoot]),
        ],
        title: group.displayName,
        description: [targetProject.workspaceRoot, targetProject.environmentLabel]
          .filter(Boolean)
          .join(" · "),
        icon: (
          <ProjectFavicon
            className="size-4 shrink-0"
            cwd={targetProject.workspaceRoot}
            projectName={targetProject.title}
            environmentId={targetProject.environmentId}
            faviconPath={targetProject.faviconPath}
          />
        ),
        run: async () => {
          await handleNewThread(scopeProjectRef(targetProject.environmentId, targetProject.id));
        },
      })),
    [handleNewThread, projectPickerEntries],
  );
  const settingsItems = useMemo<CommandPaletteActionItem[]>(
    () =>
      SETTINGS_SEARCH_ITEMS.map((item) => ({
        kind: "action",
        value: `setting:${item.id}`,
        searchTerms: [item.title, item.section, ...item.searchTerms],
        title: item.title,
        description: item.section,
        icon: <SettingsIcon className="size-4 shrink-0 text-icon-muted" />,
        run: async () => {
          await navigate({
            to: item.to,
            hash: item.targetId ?? item.id,
          });
        },
      })),
    [navigate],
  );
  const projectViewGroups = useMemo<CommandPaletteGroup[]>(
    () =>
      projectItems.length > 0
        ? [{ value: "projects", label: "Projects", items: projectItems }]
        : [],
    [projectItems],
  );

  useLayoutEffect(() => {
    if (props.openIntent?.kind !== "new-thread-in") return;
    setView("projects");
    setQuery("");
    props.clearOpenIntent();
  }, [props.clearOpenIntent, props.openIntent]);

  const projectByRef = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const messageMatchByThreadKey = new Map(
    messageSearch.matches.map((match) => [`${match.environmentId}:${match.threadId}`, match]),
  );
  const visibleThreads =
    query.trim().length > 0
      ? threads
      : threads
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 12);
  const threadItems: CommandPaletteActionItem[] = visibleThreads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => {
      const match = messageMatchByThreadKey.get(`${thread.environmentId}:${thread.id}`);
      const project = projectByRef.get(`${thread.environmentId}:${thread.projectId}`);
      const projectTitle = project?.title ?? "Unknown project";
      return {
        kind: "action",
        value: `thread:${thread.environmentId}:${thread.id}`,
        searchTerms: [thread.title, projectTitle, thread.branch ?? "", match?.snippet ?? ""],
        title: thread.title,
        titleLeadingContent: <ThreadRowLeadingStatus thread={thread} />,
        titleTrailingContent: <ThreadRowTrailingStatus thread={thread} />,
        description: (
          <ThreadCommandSubtitle
            environmentId={thread.environmentId}
            projectCwd={project?.workspaceRoot ?? null}
            projectFaviconPath={project?.faviconPath ?? null}
            projectTitle={projectTitle}
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
      run: async () => openFileViewerCommand("filePicker.toggle"),
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
      run: async () => openFileViewerCommand("projectSearch.toggle"),
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

  const rootGroups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: actionItems },
    ...(query.trim().length > 0 && projectItems.length > 0
      ? [{ value: "projects-search", label: "Projects", items: projectItems }]
      : []),
    ...(query.trim().length > 0
      ? [{ value: "settings-search", label: "Settings", items: settingsItems }]
      : []),
    ...(threadItems.length > 0
      ? [
          {
            value: query.trim().length > 0 ? "threads-search" : "recent-threads",
            label: query.trim().length > 0 ? "Threads" : "Recent threads",
            items: threadItems,
          },
        ]
      : []),
  ];
  const activeGroups = view === "projects" ? projectViewGroups : rootGroups;
  const filteredGroups = filterCommandPaletteGroups({ groups: activeGroups, query });

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
    if (item.kind === "submenu") {
      setView("projects");
      setQuery("");
      setHighlightedItemValue(null);
      return;
    }
    if (!item.keepOpen) props.setOpen(false);
    void item.run();
  };

  return (
    <CommandPaletteContent
      key={view}
      autoHighlight="always"
      escapeLabel={view === "projects" ? "Back" : "Close"}
      footerActionLabel={view === "projects" ? "Start thread" : "Open"}
      inputProps={{
        placeholder: view === "projects" ? "Choose a project…" : "Search commands and threads…",
        onKeyDown: (event) => {
          if (
            (event.key === "Escape" || event.key === "Backspace") &&
            view === "projects" &&
            query.length === 0
          ) {
            event.preventDefault();
            event.stopPropagation();
            setView("root");
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
      showBackHint={view === "projects"}
      testId="command-palette"
      value={query}
    >
      <CommandPaletteResults
        groups={filteredGroups}
        highlightedItemValue={highlightedItemValue}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(messageSearch.isPending ? { emptyStateMessage: "Searching threads…" } : {})}
      />
    </CommandPaletteContent>
  );
}
