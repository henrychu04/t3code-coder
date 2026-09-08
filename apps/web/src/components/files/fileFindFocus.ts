/** Keep editor-driven selection and render updates from taking focus from Find. */
export function retainFileFindFocus(findBar: HTMLElement): () => void {
  const document = findBar.ownerDocument;
  const fileViewer = findBar.closest("[data-file-viewer]");
  let focusedControl: HTMLElement | null = null;

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (findBar.contains(target)) {
      focusedControl = target;
    } else if (
      focusedControl?.isConnected &&
      event
        .composedPath()
        .some(
          (element) =>
            element instanceof HTMLElement &&
            element.matches("diffs-container") &&
            fileViewer?.contains(element),
        )
    ) {
      focusedControl.focus({ preventScroll: true });
    } else {
      focusedControl = null;
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.composedPath().includes(findBar)) focusedControl = null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") focusedControl = null;
  };

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
