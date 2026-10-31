// Upstream's useRightPanelSurfaceClose. Coder: there are no browser surfaces, so no preview
// session closes with a surface and no agent-controlled browser asks first.
import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { useThreadTerminalActions } from "../components/terminal/useThreadTerminalActions";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { focusPanelTerminalAfterClose } from "../lib/terminalFocus";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { readEnvironmentScope } from "../state/session";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useStableCallback } from "./useStableCallback";

/**
 * Closes right panel surfaces for a thread. A terminal tab's sessions go with
 * it, and closing a terminal tab asks first.
 */
export function useRightPanelSurfaceClose(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
}) {
  const { threadRef, terminalLabelsById } = input;
  const terminalActions = useThreadTerminalActions(threadRef);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );

  const releaseSurfaceResources = (ref: ScopedThreadRef, surface: RightPanelSurface) => {
    if (
      surface.kind === "terminal" &&
      readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)
    ) {
      for (const terminalId of surface.terminalIds) {
        storeCloseTerminal(ref, terminalId);
        terminalActions.closeTerminalSession(terminalId, ref);
      }
    }
  };
  // The active surface closes last so the panel does not flash through it.
  const finishClose = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    const store = useRightPanelStore.getState();
    const activeId = selectThreadRightPanelState(store.byThreadKey, threadRef).activeSurfaceId;
    const ordered = toClose.toSorted(
      (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
    );
    for (const surface of ordered) {
      // Releasing a browser drops its session, which prunes the tab automatically; close it
      // first so the close stays a user action that hides the panel after the last tab.
      store.closeSurface(threadRef, surface.id);
      releaseSurfaceResources(threadRef, surface);
    }
    focusPanelTerminalAfterClose(threadRef, activeId);
  };
  const labelFor = (terminalId: string) =>
    terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
  const closeSurfaces = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    finishClose(toClose);
  };

  const closeSurface = useStableCallback((surface: RightPanelSurface) => {
    if (!threadRef) return;
    if (
      surface.kind !== "terminal" ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    ) {
      finishClose([surface]);
      return;
    }
    const otherLabels = surface.terminalIds
      .filter((terminalId) => terminalId !== surface.activeTerminalId)
      .map(labelFor);
    void confirmTerminalClose([labelFor(surface.activeTerminalId), ...otherLabels]).then(
      (confirmed) => {
        if (confirmed) finishClose([surface]);
      },
    );
  });
  const closeOtherSurfaces = useStableCallback((surface: RightPanelSurface) =>
    closeSurfaces(surfaces.filter((entry) => entry.id !== surface.id)),
  );
  const closeSurfacesToRight = useStableCallback((surface: RightPanelSurface) => {
    const surfaceIndex = surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;
    closeSurfaces(surfaces.slice(surfaceIndex + 1));
  });
  const closeAllSurfaces = useStableCallback(() => closeSurfaces(surfaces));

  return { closeSurface, closeOtherSurfaces, closeSurfacesToRight, closeAllSurfaces };
}
