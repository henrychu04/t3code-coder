import { describe, expect, it } from "vite-plus/test";

import { selectionHoldsComposerOpen } from "./composerSelectionHold";

function node(parent: Node | null = null) {
  const self = {
    parent,
    contains(other: Node | null): boolean {
      let cursor: { parent: Node | null } | null = other as unknown as { parent: Node | null };
      while (cursor) {
        if (cursor === (self as unknown)) return true;
        cursor = cursor.parent as { parent: Node | null } | null;
      }
      return false;
    },
  };
  return self as unknown as Node;
}

const selection = (anchor: Node, collapsed = false) => ({
  isCollapsed: collapsed,
  rangeCount: 1,
  getRangeAt: () => ({ commonAncestorContainer: anchor }) as Range,
});

describe("selectionHoldsComposerOpen", () => {
  const timeline = node();
  const message = node(timeline);
  const elsewhere = node();

  it("holds for a range inside the timeline", () => {
    expect(selectionHoldsComposerOpen(selection(message), timeline)).toBe(true);
  });

  it("ignores carets, outside selections, and missing inputs", () => {
    expect(selectionHoldsComposerOpen(selection(message, true), timeline)).toBe(false);
    expect(selectionHoldsComposerOpen(selection(elsewhere), timeline)).toBe(false);
    expect(selectionHoldsComposerOpen(null, timeline)).toBe(false);
    expect(selectionHoldsComposerOpen(selection(message), null)).toBe(false);
  });
});
