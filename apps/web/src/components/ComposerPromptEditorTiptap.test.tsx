// @vitest-environment happy-dom
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
