// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { retainFileFindFocus } from "./fileFindFocus";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
});

function setup() {
  const viewer = document.createElement("div");
  viewer.setAttribute("data-file-viewer", "");
  const findBar = document.createElement("div");
  const input = document.createElement("input");
  const next = document.createElement("button");
  findBar.append(input, next);
  const editor = document.createElement("diffs-container");
  const content = document.createElement("div");
  content.contentEditable = "true";
  content.tabIndex = 0;
  editor.attachShadow({ mode: "open" }).append(content);
  viewer.append(findBar, editor);
  document.body.append(viewer);
  cleanup = retainFileFindFocus(findBar);
  input.focus();
  return { input, next, editor, content };
}

describe("file find focus", () => {
  it("retains the input and caret through repeated deferred editor focus attempts", async () => {
    const { input, content } = setup();
    for (const character of "search") {
      input.value += character;
      input.setSelectionRange(input.value.length, input.value.length);
      // The editor schedules focus after selection changes and virtualized renders.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          content.focus();
          resolve();
        }),
      );
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(input.value.length);
    }
  });

  it("retains focus on match navigation controls", () => {
    const { next, content } = setup();
    next.focus();
    content.focus();
    expect(document.activeElement).toBe(next);
  });

  it("allows clicking into the editor", () => {
    const { content, editor } = setup();
    content.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    content.focus();
    expect(document.activeElement).toBe(editor);
  });

  it.each([false, true])("allows tabbing out (shift: %s)", (shiftKey) => {
    const { input, content, editor } = setup();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
    content.focus();
    expect(document.activeElement).toBe(editor);
  });

  it("allows focus elsewhere and releases retention on close", () => {
    const { input, content, editor } = setup();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    expect(document.activeElement).toBe(other);
    content.focus();
    expect(document.activeElement).toBe(editor);
    input.focus();
    cleanup?.();
    content.focus();
    expect(document.activeElement).toBe(editor);
  });
});
