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
  const [openDetail, setOpenDetail] = useState<CommandPaletteOpenDetail>({});
  const keybindings = useEnvironmentKeybindings(useActiveEnvironmentId());
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        setOpenDetail(detail);
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
      setOpenDetail({});
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
              openDetail={openDetail}
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
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
        });
  const [view, setView] = useState<"root" | "projects">("root");
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
          ...group.memberProjects.flatMap((project) => [project.title, project.workspaceRoot]),
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
        searchTerms: [
          thread.title,
          projectTitle,
          thread.branch ?? "",
          match?.snippet ?? "",
          ...threadPullRequestSearchTerms(thread),
        ],
        title: thread.title,
        titleLeadingContent: <ThreadRowLeadingStatus thread={thread} />,
        titleTrailingContent: <ThreadRowTrailingStatus thread={thread} />,
        description: (
          <ThreadCommandSubtitle
            project={project ?? null}
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
  if (props.openDetail.linkedThreads && query === props.openDetail.query) {
    threadItems.splice(
      0,
      threadItems.length,
      ...props.openDetail.linkedThreads.threads.map(
        (thread): CommandPaletteActionItem => ({
          kind: "action",
          value: `linked-thread:${thread.id}`,
          title: thread.title,
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
        searchTerms: ["linked", "mr", "merge requests"],
        run: async () => {
          useRightPanelStore.getState().open(ref, "pull-requests");
        },
      },
    );
  }

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
