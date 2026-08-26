interface FileEditorDismissalOptions {
  root: HTMLElement;
  editor: { setSelections: (selections: []) => void };
  isBlocked: () => boolean;
  onDismiss: () => void;
}

function dismiss({ root, editor, onDismiss }: Omit<FileEditorDismissalOptions, "isBlocked">) {
  onDismiss();
  editor.setSelections([]);
  const active = root.querySelector<HTMLElement>("diffs-container")?.shadowRoot?.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

export function installFileEditorDismissal(options: FileEditorDismissalOptions): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (options.isBlocked() || event.composedPath().includes(options.root)) return;
    dismiss(options);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const active =
      options.root.querySelector<HTMLElement>("diffs-container")?.shadowRoot?.activeElement;
    if (
      event.key !== "Escape" ||
      options.isBlocked() ||
      !(active instanceof HTMLElement) ||
      !active.hasAttribute("data-content")
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss(options);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
