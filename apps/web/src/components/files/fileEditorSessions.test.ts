import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

import {
  clearFileEditorSessions,
  confirmFileEditorSession,
  getFileEditorSession,
} from "./fileEditorSessions";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("test-thread"),
);
const identity = { threadRef, cwd: "/workspace/project", relativePath: "src/index.ts" };

describe("file editor sessions", () => {
  beforeEach(() => {
    clearFileEditorSessions();
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("retains an editor while its file tab remains open", () => {
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const first = getFileEditorSession(identity, "first", "revision-1");

    useRightPanelStore.getState().close(threadRef);
    const reopened = getFileEditorSession(identity, "first", "revision-1");

    expect(reopened.editor).toBe(first.editor);
    expect(reopened.cacheKey).toBe(first.cacheKey);
  });

  it("releases an editor when its file tab closes", () => {
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const first = getFileEditorSession(identity, "first", "revision-1");
    const cleanUp = vi.spyOn(first.editor, "cleanUp");

    useRightPanelStore.getState().closeSurface(threadRef, `file:${identity.relativePath}`);
    expect(cleanUp).not.toHaveBeenCalled();
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const reopened = getFileEditorSession(identity, "first", "revision-1");

    expect(reopened.editor).not.toBe(first.editor);
  });

  it("invalidates the document cache key when workspace contents change", () => {
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const first = getFileEditorSession(identity, "first", "revision-1");
    const firstCacheKey = first.cacheKey;

    const updated = getFileEditorSession(identity, "changed externally", "revision-2");

    expect(updated.editor).toBe(first.editor);
    expect(updated.cacheKey).not.toBe(firstCacheKey);
  });

  it("keeps the document cache key when confirming the editor's own write", () => {
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const session = getFileEditorSession(identity, "first", "revision-1");
    const firstCacheKey = session.cacheKey;
    session.contents = "first edited";
    session.dirty = true;

    confirmFileEditorSession(identity, session.contents, "revision-2");

    expect(session.cacheKey).toBe(firstCacheKey);

    const externallyUpdated = getFileEditorSession(identity, "external", "revision-3");
    expect(externallyUpdated.cacheKey).not.toBe(firstCacheKey);
  });

  it("replaces the editor when the tab resolves against a different workspace root", () => {
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    const first = getFileEditorSession(identity, "first", "revision-1");

    const moved = getFileEditorSession(
      { ...identity, cwd: "/workspace/worktree" },
      "first",
      "revision-1",
    );

    expect(moved.editor).not.toBe(first.editor);
  });
});
