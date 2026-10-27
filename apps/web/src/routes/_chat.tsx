import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, useMatches } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { useClientSettings } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const canOperatePreview = useEnvironmentScope(
    routeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const projectGroupCount = buildSidebarProjectSnapshots({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  }).length;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.newWithoutProject") {
        const environmentId = scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
        );
        if (environmentId === null) return;
        event.preventDefault();
        event.stopPropagation();
        void startScratchThread(environmentId);
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // Coder: there is no legacy sidebar.
        if (projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    canOperatePreview,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    primaryEnvironmentId,
    projectGroupCount,
    routeThreadRef,
    scratchEnvironmentId,
    selectedThreadKeysSize,
    startScratchThread,
    terminalOpen,
  ]);

  return null;
}

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {modalOpen ? null : <ChatRouteGlobalShortcuts />}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

// Coder owns authentication, so there is no pairing gate in front of the chat routes.
export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ location }) => ({ appModalPage: isAppModalPage(location.pathname) }),
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
