import type { AnyRouter } from "@tanstack/react-router";

import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { shouldCreateNewThreadInCurrentProject } from "../components/Sidebar.logic";
import { createNewThreadHandler, resolveDefaultProjectRef } from "../hooks/useHandleNewThread";
import { createScratchProjectActions } from "../hooks/useScratchProject";
import { getClientSettings } from "../hooks/useSettings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readProjects, readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/**
 * New-thread commands, live while a chat route is showing and no
 * modal page (Settings, Usage) covers it. Everything is read at event time, so
 * the scope is registered once instead of re-registering on every store change.
 */
export function installChatRouteCommands(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = createScratchProjectActions({
    environments: () =>
      [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
        ([environmentId, presentation]) => ({ ...presentation, environmentId }),
      ),
    primaryEnvironmentId: () => appAtomRegistry.get(primaryEnvironmentIdAtom),
    registry: appAtomRegistry,
    handleNewThread,
  });

  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const readRouteThreadRef = () => {
    const target = readRouteTarget();
    return target?.kind === "server" ? target.threadRef : null;
  };
  const readThreadContext = () => {
    const target = readRouteTarget();
    const drafts = useComposerDraftStore.getState();
    const activeThread = target?.kind === "server" ? readThreadShell(target.threadRef) : null;
    const activeDraftThread = target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null;
    return {
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef: resolveDefaultProjectRef(
        readProjects(),
        useUiStateStore.getState().projectOrder,
      ),
      handleNewThread,
    };
  };
  // Grouped like the sidebar, so the shortcut and the New thread button agree.
  const readProjectGroups = () =>
    buildSidebarProjectSnapshots({
      projects: readProjects(),
      groupScratchProjects: true,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    });

  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const startNewLocal: CommandHandler = (event) => {
    claim(event);
    // With no current or open project, such as when every project is archived, pick one.
    void startNewThreadFromContext(readThreadContext()).then((started) => {
      if (!started) openCommandPalette({ open: "new-thread-in" });
    });
  };

  return registerCommands(
    {
      "chat.newLocal": startNewLocal,
      "chat.newWithoutProject": (event) => {
        const { activeThread, activeDraftThread } = readThreadContext();
        const environmentId = scratch.scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null,
        );
        if (environmentId === null) return;
        claim(event);
        void scratch.startScratchThread(environmentId);
      },
      "chat.new": (event) => {
        // The boring sidebar's folders already show the context, so it starts in
        // the current project like the legacy sidebar did.
        const { boringSidebarEnabled, legacySidebarEnabled } = getClientSettings();
        const groups = readProjectGroups();
        if (
          !boringSidebarEnabled &&
          !legacySidebarEnabled &&
          !shouldCreateNewThreadInCurrentProject(
            false,
            groups.filter((group) => !group.archived).length,
            groups.length,
          )
        ) {
          claim(event);
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        startNewLocal(event);
      },
      // Coder: no browser preview, so no preview commands.
    },
    {
      when: () =>
        router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
        !router.state.matches.some((match) => isAppModalPage(match.pathname)) &&
        !isCommandPaletteOpen(),
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
        };
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape") return false;
        const selection = useThreadSelectionStore.getState();
        if (selection.selectedThreadKeys.size === 0) return false;
        event.preventDefault();
        selection.clearSelection();
      },
    },
  );
}
