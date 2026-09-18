// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import {
  ComposerPromptEditor as ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditor";
import type { TerminalContextDraft } from "../lib/terminalContext";

vi.mock("./chat/ComposerPendingTerminalContexts", () => ({
  ComposerPendingTerminalContextChip: ({ context }: { context: TerminalContextDraft }) => (
    <span>{context.terminalLabel}</span>
  ),
}));
let root: Root | undefined;
let container: HTMLDivElement;
const editorRef = createRef<ComposerPromptEditorHandle>();
const terminal = (id: string): TerminalContextDraft => ({
  id,
  threadId: ThreadId.make("thread"),
  terminalId: id,
  terminalLabel: id,
  lineStart: 1,
  lineEnd: 1,
  text: "workspace output",
  createdAt: "2026-01-01T00:00:00Z",
});
async function render(value: string, contexts: TerminalContextDraft[], richTextEnabled = true) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      <ComposerPromptEditorTiptap
        value={value}
        cursor={0}
        richTextEnabled={richTextEnabled}
        terminalContexts={contexts}
        images={[]}
        skills={[]}
        disabled={false}
        placeholder="Prompt"
        onRemoveTerminalContext={() => {}}
        onChange={() => {}}
        onPaste={() => {}}
        editorRef={editorRef}
      />,
    );
  });
  await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
describe("Coder rich-text editor", () => {
  it("renders formatting while retaining Markdown in the draft", async () => {
    await render("**bold** and `code`", []);
    expect(container.querySelector("strong")?.textContent).toContain("bold");
    expect(editorRef.current!.readSnapshot().value).toBe("**bold** and `code`");
    await render("**bold** and `code`", [], false);
    expect(container.querySelector("strong")).toBeNull();
    expect(editorRef.current!.readSnapshot().value).toBe("**bold** and `code`");
  });
  it("retains and updates terminal identities even when placeholder text is unchanged", async () => {
    await render("Inspect \uFFFC then \uFFFC", [terminal("first"), terminal("second")]);
    expect(editorRef.current!.readSnapshot().terminalContextIds).toEqual(["first", "second"]);
    await render("Inspect \uFFFC then \uFFFC", [terminal("second"), terminal("first")]);
    expect(editorRef.current!.readSnapshot().terminalContextIds).toEqual(["second", "first"]);
    expect(editorRef.current!.readSnapshot().value).toBe("Inspect \uFFFC then \uFFFC");
  });
});
