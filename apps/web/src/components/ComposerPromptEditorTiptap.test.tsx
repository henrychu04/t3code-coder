// @vitest-environment happy-dom
import { longTextContextReference } from "../lib/composerInlineContext";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import { formatReviewCommentContext } from "../reviewCommentContext";
import { buildPullRequestReferenceContext } from "./pullRequest/pullRequestDetail.logic";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import {
  ComposerPromptEditor as ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditor";
import type { TerminalContextDraft } from "../lib/terminalContext";

vi.mock("./chat/ComposerPendingTerminalContexts", () => ({
  ComposerPendingTerminalContextChip: ({ context }: { context: TerminalContextDraft }) => (
    <span>{context.terminalLabel}</span>
  ),
}));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
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
async function render(
  value: string,
  contexts: TerminalContextDraft[],
  richTextEnabled = true,
  props: Partial<ComposerPromptEditorProps> = {},
) {
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
        {...props}
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
  it("opens a merge-request reference through the Coder action and retains its snapshot", async () => {
    const metadata = {
      number: 42,
      title: "Fix",
      url: "https://gitlab.com/team/repo/-/merge_requests/42",
      headBranch: "fix",
      baseBranch: "main",
      state: "merged" as const,
      isDraft: false,
    };
    const value = formatReviewCommentContext(buildPullRequestReferenceContext(metadata));
    const openPullRequest = vi.fn();
    await render(value, [], true, {
      fileActions: { openMention: () => {}, canOpenMention: () => false, openPullRequest },
    });
    const chip = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open merge request #42: Fix"]',
    );
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
    expect(openPullRequest).toHaveBeenCalledWith(expect.anything(), metadata.url);
    expect(editorRef.current!.readSnapshot().value).toBe(value);
  });
  it("restores removed terminal payloads through upstream undo history", async () => {
    const original = terminal("undo-terminal");
    function ControlledEditor() {
      const [value, setValue] = useState("Inspect \uFFFC");
      const [contexts, setContexts] = useState([original]);
      return (
        <ComposerPromptEditorTiptap
          value={value}
          cursor={0}
          terminalContexts={contexts}
          skills={[]}
          disabled={false}
          placeholder="Prompt"
          onRemoveTerminalContext={() => {}}
          onPaste={() => {}}
          editorRef={editorRef}
          onChange={(next, _cursor, _expanded, _adjacent, _ids, restored) => {
            setValue(next);
            setContexts(restored ?? []);
          }}
        />
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ControlledEditor />));
    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!;
    await act(async () => {
      element.editor.commands.selectAll();
      element.editor.commands.deleteSelection();
    });
    expect(editorRef.current!.readSnapshot().terminalContextIds).toEqual([]);
    await act(async () => {
      element.editor.commands.undo();
    });
    expect(editorRef.current!.readSnapshot().value).toBe("Inspect \uFFFC");
    expect(editorRef.current!.readSnapshot().terminalContextIds).toEqual([original.id]);
    expect(container.textContent).toContain(original.terminalLabel);
  });
  it("keeps the caret beside a pasted legacy context instead of jumping past trailing text", async () => {
    const onChange = vi.fn();
    await render("before after", [], true, { onChange });
    const source = longTextContextReference("captured text");
    await act(async () => editorRef.current!.focusAt(7));
    const element = container.querySelector<HTMLElement>(".tiptap")!;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [], getData: (type: string) => (type === "text/plain" ? source : "") },
    });
    await act(async () => {
      element.dispatchEvent(event);
    });
    const change = onChange.mock.calls.at(-1)!;
    expect(change[0]).toBe(`before ${source}after`);
    expect(change[1]).toBe(8);
    expect(change[2]).toBe(7 + source.length);
  });
  it("opens a file mention through its workspace action without changing the draft", async () => {
    const openMention = vi.fn();
    await render("Inspect [index.ts](src/index.ts) please", [], true, {
      fileActions: { openMention, canOpenMention: () => true },
    });
    await vi.waitFor(() =>
      expect(container.querySelector("[data-composer-mention-chip]")).not.toBeNull(),
    );
    const chip = container.querySelector<HTMLButtonElement>("[data-composer-mention-chip]")!;
    expect(chip).not.toBeNull();
    await act(async () => chip.click());
    expect(openMention).toHaveBeenCalledWith("src/index.ts");
    expect(editorRef.current!.readSnapshot().value).toBe("Inspect [index.ts](src/index.ts) please");
  });
  it("disables file actions when no authorized project target is available", async () => {
    const openMention = vi.fn();
    await render("Inspect @/outside/secret.txt please", [], true, {
      fileActions: { openMention, canOpenMention: () => false },
    });
    await vi.waitFor(() =>
      expect(container.querySelector("[data-composer-mention-chip]")).not.toBeNull(),
    );
    const chip = container.querySelector<HTMLButtonElement>("[data-composer-mention-chip]")!;
    expect(chip.disabled).toBe(true);
    await act(async () => chip.click());
    expect(openMention).not.toHaveBeenCalled();
  });

  it.each([true, false])("shows skill details with project access %s", async (allowed) => {
    const openMention = vi.fn();
    await render("Use $review please", [], true, {
      skills: [
        {
          name: "review",
          path: "/project/skills/review.md",
          description: "Review workspace changes",
          enabled: true,
        },
      ],
      fileActions: { openMention, canOpenMention: () => allowed },
    });
    const chip = container.querySelector<HTMLButtonElement>(
      '[aria-label="Skill Review. Show details"]',
    )!;
    expect(chip).not.toBeNull();
    await act(async () => chip.click());
    expect(document.body.textContent).toContain("Review workspace changes");
    const instructions = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "View instructions",
    );
    expect(Boolean(instructions)).toBe(allowed);
    if (instructions) {
      await act(async () => instructions.click());
      expect(openMention).toHaveBeenCalledWith("/project/skills/review.md");
    }
  });
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
