import { Outlet, createFileRoute, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
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
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

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
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
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

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
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
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; single-project setups keep
        // the immediate contextual create. Coder: there is no legacy sidebar.
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

function ChatRouteLayout() {
  // Both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap.
  const threadTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  return (
    <>
      <ChatRouteGlobalShortcuts />
      {threadTarget ? <ThreadRouteView target={threadTarget} /> : <Outlet />}
    </>
  );
}

// Coder owns authentication, so there is no pairing gate in front of the chat routes.
export const Route = createFileRoute("/_chat")({ component: ChatRouteLayout });
