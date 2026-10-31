import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveExplicitDiffOpenOnActivate } from "../ChatView.logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ScopedThreadRef, type RunId } from "@t3tools/contracts";
import { useDiffPanelStore } from "../../diffPanelStore";
import { type ThreadPanelPresentation } from "../../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectThreadPanelOpen,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { requestWorkspaceContentFocus, requestWorkspaceFocus } from "../../lib/workspaceFocus";
import { focusActivePanelTerminal, focusTerminal } from "../../lib/terminalFocus";
import type { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatShortcutCommands } from "./useChatShortcuts";
interface RightPanelActionsInput {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly pullRequestPanelTarget: ReturnType<typeof threadPullRequestPanelTarget> | null;
  readonly threadPanelPresentation: ThreadPanelPresentation;
  readonly isServerThread: boolean;
  // Coder: no `embedded` flag; it only kept side chat panes off the cut preview action bus.
  readonly isGitRepo: boolean;
  readonly diffOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly canMaximizeRightPanel: boolean;
  readonly rightPanelMaximized: boolean;
  readonly supportsPullRequests: boolean;
  readonly pullRequestsSurfaceAvailable: boolean;
  readonly gitCwd: string | null;
  readonly activeProjectCwd: string | null;
  readonly explicitDiffOpenRef: { current: ScopedThreadRef | null };
  readonly onDiffPanelOpen: (() => void) | undefined;
  readonly closeRightPanelSurface: (surface: RightPanelSurface) => void;
}

/**
 * Opening, closing, and arranging the right panel's surfaces: diff, files, pull requests, and
 * terminal tabs. Coder: there are no browser or device surfaces.
 */
export function useRightPanelActions(input: RightPanelActionsInput) {
  const {
    closeRightPanelSurface,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    pullRequestPanelTarget,
    threadPanelPresentation,
    isServerThread,
    isGitRepo,
    diffOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    gitCwd,
    activeProjectCwd,
    explicitDiffOpenRef,
    onDiffPanelOpen,
  } = input;

  const onToggleDiff = () => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  };
  const onToggleDiffStable = useStableCallback(onToggleDiff);
  const addDiffSurface = () => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const addDiffSurfaceStable = useStableCallback(addDiffSurface);
  const openChangesFromThreadPanel = () => {
    addDiffSurface();
  };
  const openChangesFromThreadPanelStable = useStableCallback(openChangesFromThreadPanel);
  const addFilesSurface = () => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  };
  const addFilesSurfaceStable = useStableCallback(addFilesSurface);
  const addPullRequestsSurface = () => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
  };
  const addPullRequestsSurfaceStable = useStableCallback(addPullRequestsSurface);
  const openFileSurface = (relativePath: string) => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
  };
  const openFileSurfaceStable = useStableCallback(openFileSurface);
  // Coder: there are no browser or device previews to float when the panel closes.
  const closePreviewPanel = () => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().setMaximized(activeThreadRef, false);
    useRightPanelStore.getState().close(activeThreadRef);
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    explicitDiffOpenRef.current = resolveExplicitDiffOpenOnActivate({
      surfaceKind: surface.kind,
      diffOpen,
      activeThreadRef,
    });
    useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
    if (surface.kind === "terminal") {
      focusTerminal(activeThreadRef, surface.activeTerminalId);
    }
    if (surface.kind === "diff" && !diffOpen) {
      onDiffPanelOpen?.();
    }
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  const toggleRightPanel = () => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
    focusActivePanelTerminal(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    if (threadPanelPresentation === "inline") {
      const open = selectThreadPanelOpen(
        store.threadPanelVisibilityByThreadKey,
        activeThreadRef,
        "inline",
      );
      if (!open) requestWorkspaceFocus({ area: "details" });
      else if (document.activeElement?.closest('[data-workspace-area="details"]'))
        requestWorkspaceContentFocus();
    }
    store.toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    if (!rightPanelMaximized) requestWorkspaceFocus({ area: "panel" });
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    const clipboardPath = formatFilePathForClipboard(
      relativePath,
      resolvePathLinkTarget(relativePath, gitCwd ?? activeProjectCwd ?? ""),
    );
    void navigator.clipboard.writeText(clipboardPath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: clipboardPath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  const addPullRequestSurface = () => {
    if (!supportsPullRequests || activeThreadRef === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, pullRequestPanelTarget);
  };
  const addPullRequestSurfaceStable = useStableCallback(addPullRequestSurface);
  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectTurn(activeThreadRef, runId, filePath);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const onOpenToolDiffStable = useStableCallback((target: ToolCallDiffTarget) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectToolCall(activeThreadRef, target);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  });
  const onOpenTurnDiffStable = useStableCallback(onOpenTurnDiff);

  const shortcuts = {
    "rightPanel.toggle": () => toggleRightPanel(),
    "rightPanel.toggleMaximized": ({ event }) => {
      if (!event.repeat) toggleRightPanelMaximized();
    },
    "threadPanel.toggle": () => toggleThreadPanel(),
    "rightPanel.close": ({ event }) => {
      if (!activeRightPanelSurface) return false;
      if (!event.repeat) closeRightPanelSurface(activeRightPanelSurface);
    },
    "diff.toggle": () => onToggleDiff(),
  } satisfies ChatShortcutCommands;

  return {
    shortcuts,
    activateRightPanelSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    onOpenTurnDiffStable,
    onToggleDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
  };
}
