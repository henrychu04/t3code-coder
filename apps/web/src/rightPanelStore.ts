/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Terminal surfaces point at terminal session
 * ids, file surfaces point at workspace paths, and diff/files remain singleton
 * surfaces. Coder omits upstream's browser preview, device, and attachment
 * surfaces, and keeps panel state in memory rather than browser storage.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "terminal",
  "pull-request",
  "pull-requests",
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
      /** Workspace-relative, or absolute for a host file outside the workspace. */
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | {
      /**
       * A change request opened beside a thread or in the pull-request list's shared panel.
       * The reference lives in the id so several pull requests can remain open as peer tabs.
       */
      id: `pull-request:${string}`;
      kind: "pull-request";
      /**
       * Which server the change request was read from. The list spans every connected one, so
       * two of them can hold the same project id; a panel beside a thread leaves this out and
       * takes the environment from its own ref.
       */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    }
  /** The thread's linked pull requests, one singleton tab beside any number of `pull-request` tabs. */
  | { id: "pull-requests"; kind: "pull-requests" }
  | { id: "agents"; kind: "agents" };

/** A fixed workspace-level ref: each PR surface carries its own real environment. */
export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /** Session-only count of user panel choices per thread. Automatic updates do not advance it. */
  userActionRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  /**
   * Open a surface on behalf of the app, not the user. Refused when the user
   * made a panel choice after `expectedUserActionRevision` was read.
   */
  openProactive: (
    ref: ScopedThreadRef,
    surface: Extract<RightPanelSurface, { kind: "diff" | "pull-request" | "pull-requests" }>,
    expectedUserActionRevision: number,
  ) => boolean;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    },
  ) => void;
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
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
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

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "pull-requests":
      return { id: "pull-requests", kind };
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

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  // The environment leads the id where there is one, so the same change request read from two
  // servers is two tabs rather than one tab that changes its mind about which server it is on.
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
  };
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

// Every store action is a user choice unless it goes through `automaticUpdate`.
// Only `openProactive` and resource reconciliation are automatic, so a new
// action counts as a user choice by default.
const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, updater),
});

const userAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, updater),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
});

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

export const useRightPanelStore = create<RightPanelStoreState>()((set, get) => ({
  byThreadKey: {},
  userActionRevisionByThreadKey: {},
  getUserActionRevision: (ref) => get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
  openProactive: (ref, surface, expectedUserActionRevision) => {
    let opened = false;
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if ((state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision) {
        return state;
      }
      // A linked PR takes priority over a completed-turn diff. Manual actions
      // always apply, and later user choices reject both proactive requests.
      if (
        surface.kind === "diff" &&
        (selectActiveRightPanel(state.byThreadKey, ref) === "pull-request" ||
          selectActiveRightPanel(state.byThreadKey, ref) === "pull-requests")
      ) {
        return state;
      }
      opened = true;
      return automaticUpdate(state, threadKey, (current) => upsertSurface(current, surface));
    });
    return opened;
  },
  open: (ref, kind) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        upsertSurface(current, singletonSurface(kind)),
      ),
    ),
  openPullRequest: (ref, target) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const surface = pullRequestSurface(target);
        const next = upsertSurface(current, surface);
        return target.url
          ? {
              ...next,
              surfaces: next.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
            }
          : next;
      }),
    ),
  openFile: (ref, requestedPath, line) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        // Workspace entry paths use '/', including on Windows.
        const relativePath = /^[A-Za-z]:\/+$/.test(requestedPath)
          ? requestedPath
          : requestedPath.replace(/\/+$/, "") || requestedPath;
        if (relativePath === ".") return upsertSurface(current, singletonSurface("files"));
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
            ? withoutStandaloneExplorer.map((entry) => (entry.id === surface.id ? surface : entry))
            : [...withoutStandaloneExplorer, surface],
        };
      }),
    ),
  openTerminal: (ref, terminalId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        upsertSurface(current, terminalSurface(terminalId)),
      ),
    ),
  splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => ({
        ...current,
        isOpen: true,
        activeSurfaceId: surfaceId,
        surfaces: current.surfaces.map((surface) => {
          if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
          const { splitDirection: _splitDirection, ...baseSurface } = surface;
          return {
            ...baseSurface,
            terminalIds: surface.terminalIds.includes(terminalId)
              ? surface.terminalIds
              : [...surface.terminalIds, terminalId],
            activeTerminalId: terminalId,
            ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
          };
        }),
      })),
    ),
  activateTerminal: (ref, surfaceId, terminalId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => ({
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
    ),
  closeTerminal: (ref, surfaceId, terminalId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const surface = current.surfaces.find(
          (entry) => entry.id === surfaceId && entry.kind === "terminal",
        );
        if (!surface || surface.kind !== "terminal") return current;
        const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
        if (terminalIds.length === 0) {
          const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
          const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
          const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
          return {
            ...current,
            isOpen: surfaces.length > 0 && current.isOpen,
            surfaces,
            activeSurfaceId:
              current.activeSurfaceId === surfaceId
                ? (fallback?.id ?? null)
                : current.activeSurfaceId,
          };
        }
        return {
          ...current,
          surfaces: current.surfaces.map((entry) =>
            entry.id === surfaceId && entry.kind === "terminal"
              ? {
                  ...entry,
                  terminalIds,
                  activeTerminalId:
                    entry.activeTerminalId === terminalId
                      ? (terminalIds.at(-1) ?? terminalIds[0]!)
                      : entry.activeTerminalId,
                }
              : entry,
          ),
        };
      }),
    ),
  activateSurface: (ref, surfaceId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        current.surfaces.some((surface) => surface.id === surfaceId)
          ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
          : current,
      ),
    ),
  closeSurface: (ref, surfaceId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0) return current;
        const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
        if (current.activeSurfaceId !== surfaceId) {
          return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
        }
        const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
        return {
          ...current,
          isOpen: surfaces.length > 0 && current.isOpen,
          surfaces,
          activeSurfaceId: fallback?.id ?? null,
        };
      }),
    ),
  closeOtherSurfaces: (ref, surfaceId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const surface = current.surfaces.find((entry) => entry.id === surfaceId);
        if (!surface || current.surfaces.length === 1) return current;
        return {
          ...current,
          isOpen: true,
          surfaces: [surface],
          activeSurfaceId: surface.id,
        };
      }),
    ),
  closeSurfacesToRight: (ref, surfaceId) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0 || index === current.surfaces.length - 1) return current;
        const surfaces = current.surfaces.slice(0, index + 1);
        const activeStillExists = surfaces.some(
          (surface) => surface.id === current.activeSurfaceId,
        );
        return {
          ...current,
          surfaces,
          activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
        };
      }),
    ),
  closeAllSurfaces: (ref) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        current.surfaces.length === 0
          ? current
          : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
      ),
    ),
  reconcileFileSurfaces: (ref, workspaceAvailable) =>
    set((state) =>
      automaticUpdate(state, scopedThreadKey(ref), (current) => {
        if (workspaceAvailable) return current;
        const surfaces = current.surfaces.filter(
          (surface) => surface.kind !== "files" && surface.kind !== "file",
        );
        if (surfaces.length === current.surfaces.length) return current;
        const activeStillExists = surfaces.some(
          (surface) => surface.id === current.activeSurfaceId,
        );
        return {
          ...current,
          isOpen: surfaces.length > 0 ? current.isOpen : false,
          surfaces,
          activeSurfaceId: activeStillExists
            ? current.activeSurfaceId
            : (surfaces.at(-1)?.id ?? null),
        };
      }),
    ),
  show: (ref) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        current.isOpen ? current : { ...current, isOpen: true },
      ),
    ),
  close: (ref) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) =>
        current.isOpen ? { ...current, isOpen: false } : current,
      ),
    ),
  toggleVisibility: (ref) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => ({
        ...current,
        isOpen: !current.isOpen,
      })),
    ),
  toggle: (ref, kind) =>
    set((state) =>
      userAction(state, scopedThreadKey(ref), (current) => {
        const active = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
        if (current.isOpen && active?.kind === kind) {
          return { ...current, isOpen: false };
        }
        return upsertSurface(current, singletonSurface(kind));
      }),
    ),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (
        !(threadKey in state.byThreadKey) &&
        !(threadKey in state.userActionRevisionByThreadKey)
      ) {
        return state;
      }
      const { [threadKey]: _removed, ...rest } = state.byThreadKey;
      const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
        state.userActionRevisionByThreadKey;
      return { byThreadKey: rest, userActionRevisionByThreadKey };
    }),
}));

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
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
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
