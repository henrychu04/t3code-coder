/** Whether a live text selection inside the timeline should hold the composer open. */
export function selectionHoldsComposerOpen(
  selection: Pick<Selection, "isCollapsed" | "rangeCount" | "getRangeAt"> | null,
  timeline: Node | null,
): boolean {
  if (!timeline || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  return timeline.contains(selection.getRangeAt(0).commonAncestorContainer);
}
