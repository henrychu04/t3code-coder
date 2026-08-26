import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DiffLineAnnotation, EditorState, FileContents } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";

import type { FileCommentAnnotationGroup } from "./fileCommentAnnotations";
import { projectFileCacheKey } from "./fileContentRevision";

export interface FileEditorSessionIdentity {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
}

export interface FileEditorViewAnchor {
  readonly lineNumber: number;
  readonly viewportOffset: number;
}

interface FileEditorSession {
  readonly threadKey: string;
  readonly relativePath: string;
  readonly editor: Editor<FileCommentAnnotationGroup>;
  cacheKey: string;
  contents: string;
  sourceRevision: string;
  readonly supersededRevisions: Set<string>;
  dirty: boolean;
  state: EditorState | undefined;
  viewAnchor: FileEditorViewAnchor | undefined;
  onChange:
    | ((file: FileContents, annotations?: DiffLineAnnotation<FileCommentAnnotationGroup>[]) => void)
    | undefined;
}

const sessions = new Map<string, FileEditorSession>();

function sessionKey(identity: FileEditorSessionIdentity): string {
  return JSON.stringify([scopedThreadKey(identity.threadRef), identity.cwd, identity.relativePath]);
}

function cacheKey(identity: FileEditorSessionIdentity, contents: string): string {
  return `editor:${identity.threadRef.environmentId}:${projectFileCacheKey(
    identity.cwd,
    identity.relativePath,
    contents,
  )}`;
}

export function getFileEditorSession(
  identity: FileEditorSessionIdentity,
  contents: string,
  revision: string,
): FileEditorSession {
  const key = sessionKey(identity);
  const existing = sessions.get(key);
  if (existing) {
    if (
      !existing.dirty &&
      existing.sourceRevision !== revision &&
      !existing.supersededRevisions.has(revision)
    ) {
      existing.contents = contents;
      existing.sourceRevision = revision;
      existing.supersededRevisions.clear();
      existing.cacheKey = cacheKey(identity, contents);
      existing.state = undefined;
    }
    return existing;
  }

  const threadKey = scopedThreadKey(identity.threadRef);
  for (const [staleKey, staleSession] of sessions) {
    if (
      staleSession.threadKey === threadKey &&
      staleSession.relativePath === identity.relativePath
    ) {
      sessions.delete(staleKey);
    }
  }

  let session: FileEditorSession;
  const editor = new Editor<FileCommentAnnotationGroup>({
    persistState: true,
    persistStateStorage: "inMemory",
    onChange: (file, annotations) => {
      session.contents = file.contents;
      session.dirty = true;
      session.onChange?.(file, annotations);
    },
  });
  session = {
    threadKey,
    relativePath: identity.relativePath,
    editor,
    cacheKey: cacheKey(identity, contents),
    contents,
    sourceRevision: revision,
    supersededRevisions: new Set(),
    dirty: false,
    state: undefined,
    viewAnchor: undefined,
    onChange: undefined,
  };
  sessions.set(key, session);
  return session;
}

export function confirmFileEditorSession(
  identity: FileEditorSessionIdentity,
  contents: string,
  revision: string,
): void {
  const session = sessions.get(sessionKey(identity));
  if (!session || session.contents !== contents) return;
  if (session.sourceRevision !== revision) {
    session.supersededRevisions.add(session.sourceRevision);
  }
  session.dirty = false;
  session.sourceRevision = revision;
}

export function discardFileEditorSession(identity: FileEditorSessionIdentity): void {
  sessions.delete(sessionKey(identity));
}

export function bindFileEditorSession(
  session: FileEditorSession,
  onChange: NonNullable<FileEditorSession["onChange"]>,
): () => void {
  session.onChange = onChange;
  const state = session.state;
  let restored = state === undefined;
  const restoreFrame = state
    ? requestAnimationFrame(() => {
        if (session.onChange !== onChange) return;
        session.editor.setState(state);
        restored = true;
      })
    : null;
  return () => {
    if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
    if (restored) session.state = session.editor.getState();
    if (session.onChange === onChange) session.onChange = undefined;
  };
}

const unsubscribeRightPanelStore = useRightPanelStore.subscribe((state) => {
  for (const [key, session] of sessions) {
    const threadState = state.byThreadKey[session.threadKey];
    const remainsOpen = threadState?.surfaces.some(
      (surface) => surface.kind === "file" && surface.relativePath === session.relativePath,
    );
    if (!remainsOpen) sessions.delete(key);
  }
});

export function clearFileEditorSessions(): void {
  sessions.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeRightPanelStore();
    sessions.clear();
  });
}
