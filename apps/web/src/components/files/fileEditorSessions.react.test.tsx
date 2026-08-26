// @vitest-environment happy-dom

import { EditContext, File, Virtualizer } from "@pierre/diffs/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

import {
  bindFileEditorSession,
  clearFileEditorSessions,
  confirmFileEditorSession,
  getFileEditorSession,
} from "./fileEditorSessions";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("test-thread"),
);
const identity = { threadRef, cwd: "/workspace/project", relativePath: "src/index.ts" };

type Session = ReturnType<typeof getFileEditorSession>;

const originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
const originalElementScrollTo = HTMLElement.prototype.scrollTo;
const scrollCalls: ScrollToOptions[] = [];

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(options: ScrollToOptions | number, y?: number) {
      if (typeof options === "number") {
        this.scrollLeft = options;
        this.scrollTop = y ?? 0;
      } else {
        scrollCalls.push(options);
        this.scrollLeft = options.left ?? this.scrollLeft;
        this.scrollTop = options.top ?? this.scrollTop;
      }
    },
  });
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalCanvasGetContext,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalElementScrollTo,
  });
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function MountedFile({ session }: { readonly session: Session }) {
  useLayoutEffect(() => bindFileEditorSession(session, () => {}), [session]);
  return (
    <EditContext.Provider value={session.editor}>
      <Virtualizer className="file-preview-virtualizer">
        <File
          file={{
            name: identity.relativePath,
            contents: session.contents,
            cacheKey: session.cacheKey,
          }}
          options={{ disableFileHeader: true }}
          contentEditable
          disableWorkerPool
        />
      </Virtualizer>
    </EditContext.Provider>
  );
}

describe("retained file editor React lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    scrollCalls.length = 0;
    clearFileEditorSessions();
    useRightPanelStore.setState({ byThreadKey: {} });
    useRightPanelStore.getState().openFile(threadRef, identity.relativePath);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearFileEditorSessions();
  });

  it("restores text, undo history, selection, and scroll after a React remount", async () => {
    const session = getFileEditorSession(identity, "alpha\n", "revision-1");
    await act(async () => root.render(<MountedFile session={session} />));

    await act(async () => {
      session.editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "edited ",
        },
      ]);
      session.editor.setSelections([
        {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 2 },
          direction: "none",
        },
      ]);
    });
    const scrollContainer = container.querySelector<HTMLElement>(".file-preview-virtualizer");
    expect(scrollContainer).not.toBeNull();
    scrollContainer!.scrollTop = 37;

    await act(async () => root.render(null));
    const reopened = getFileEditorSession(identity, session.contents, "revision-1");
    scrollCalls.length = 0;
    await act(async () => root.render(<MountedFile session={reopened} />));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(reopened.editor).toBe(session.editor);
    expect(reopened.editor.getText()).toBe("edited alpha\n");
    expect(reopened.editor.canUndo).toBe(true);
    expect(reopened.editor.getState().selections).toEqual([
      {
        start: { line: 0, character: 2 },
        end: { line: 0, character: 2 },
        direction: 0,
      },
    ]);
    expect(scrollCalls).toContainEqual(expect.objectContaining({ top: 37 }));
    expect(reopened.editor.getState().view?.scrollTop).toBe(37);

    await act(async () => reopened.editor.undo());
    expect(reopened.editor.getText()).toBe("alpha\n");
  });

  it("keeps an unsaved buffer when a stale query remounts the file", async () => {
    const session = getFileEditorSession(identity, "alpha\n", "revision-1");
    await act(async () => root.render(<MountedFile session={session} />));
    await act(async () => {
      session.editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "unsaved ",
        },
      ]);
    });

    await act(async () => root.render(null));
    const reopened = getFileEditorSession(identity, "alpha\n", "revision-1");
    await act(async () => root.render(<MountedFile session={reopened} />));

    expect(reopened.editor).toBe(session.editor);
    expect(reopened.contents).toBe("unsaved alpha\n");
    expect(reopened.editor.getText()).toBe("unsaved alpha\n");

    confirmFileEditorSession(identity, reopened.contents, "revision-2");
    expect(reopened.dirty).toBe(false);
    expect(reopened.sourceRevision).toBe("revision-2");

    const afterStaleRead = getFileEditorSession(identity, "alpha\n", "revision-1");
    expect(afterStaleRead.contents).toBe("unsaved alpha\n");
    expect(afterStaleRead.sourceRevision).toBe("revision-2");

    const afterExternalRead = getFileEditorSession(identity, "external\n", "revision-3");
    expect(afterExternalRead.contents).toBe("external\n");
    expect(afterExternalRead.sourceRevision).toBe("revision-3");
  });
});
