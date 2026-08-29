import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "terminal",
  "pull-request",
  "agents",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RightPanelSurface =
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | {
      id: `pull-request:${string}`;
      kind: "pull-request";
      environmentId?: string;
      projectId: string;
      repository: string;
      number: number;
    }
  | { id: "agents"; kind: "agents" };

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: { environmentId?: string; projectId: string; repository: string; number: number },
  ) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef,
  update: (current: ThreadRightPanelState) => ThreadRightPanelState,
) => {
  const key = scopedThreadKey(ref);
  return { ...byThreadKey, [key]: update(byThreadKey[key] ?? EMPTY_THREAD_STATE) };
};

const singletonSurface = (kind: "diff" | "files" | "agents"): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "agents":
      return { id: "agents", kind };
  }
};

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

export type PullRequestSurface = Extract<
  RightPanelSurface,
  { kind: "pull-request"; number: number }
>;

export function isPullRequestSurface(
  surface: RightPanelSurface | null,
): surface is PullRequestSurface {
  return surface?.kind === "pull-request";
}

export function updatePullRequestTabStatus<Status extends { state: unknown; isDraft: boolean }>(
  statuses: Readonly<Record<string, Status>>,
  surfaceId: string,
  status: Status,
): Readonly<Record<string, Status>> {
  return statuses[surfaceId]?.state === status.state &&
    statuses[surfaceId]?.isDraft === status.isDraft
    ? statuses
    : { ...statuses, [surfaceId]: status };
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  repository: string;
  number: number;
}): PullRequestSurface {
  const environment = target.environmentId ? `${encodeURIComponent(target.environmentId)}:` : "";
  return {
    id: `pull-request:${environment}${encodeURIComponent(target.projectId)}:${encodeURIComponent(target.repository)}:${target.number}`,
    kind: "pull-request",
    ...(target.environmentId ? { environmentId: target.environmentId } : {}),
    projectId: target.projectId,
    repository: target.repository,
    number: target.number,
  };
}

const upsert = (current: ThreadRightPanelState, surface: RightPanelSurface) => ({
  isOpen: true,
  activeSurfaceId: surface.id,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
});

const removeSurface = (current: ThreadRightPanelState, surfaceId: string) => {
  const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (index < 0) return current;
  const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return {
    isOpen: surfaces.length > 0 && current.isOpen,
    surfaces,
    activeSurfaceId:
      current.activeSurfaceId === surfaceId ? (fallback?.id ?? null) : current.activeSurfaceId,
  };
};

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            upsert(current, singletonSurface(kind)),
          ),
        })),
      openPullRequest: (ref, target) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            upsert(current, pullRequestSurface(target)),
          ),
        })),
      openFile: (ref, relativePath, line) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        })),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            upsert(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "terminal"
                ? {
                    ...surface,
                    terminalIds: surface.terminalIds.includes(terminalId)
                      ? surface.terminalIds
                      : [...surface.terminalIds, terminalId],
                    activeTerminalId: terminalId,
                    ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
                  }
                : surface,
            ),
          })),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) return removeSurface(current, surfaceId);
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? terminalIds[terminalIds.length - 1]!
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            removeSurface(current, surfaceId),
          ),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            return surface
              ? { isOpen: true, activeSurfaceId: surface.id, surfaces: [surface] }
              : current;
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            return {
              ...current,
              surfaces,
              activeSurfaceId: surfaces.some((surface) => surface.id === current.activeSurfaceId)
                ? current.activeSurfaceId
                : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, () => EMPTY_THREAD_STATE),
        })),
      show: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: current.surfaces.length > 0,
          })),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: false,
          })),
        })),
      toggleVisibility: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return current.isOpen && active?.kind === kind
              ? { ...current, isOpen: false }
              : upsert(current, singletonSurface(kind));
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:coder-right-panel:v1",
      storage: createJSONStorage(createMemoryStorage),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
) {
  return ref ? (byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE) : EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
) {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
