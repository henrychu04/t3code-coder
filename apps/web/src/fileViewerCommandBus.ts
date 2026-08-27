import type { KeybindingCommand } from "@t3tools/contracts";

export type FileViewerCommand = Extract<
  KeybindingCommand,
  "filePicker.toggle" | "fileViewer.searchFiles" | "projectSearch.toggle"
>;

const FILE_VIEWER_COMMAND_EVENT = "t3code:file-viewer-command";

export function openFileViewerCommand(command: FileViewerCommand): void {
  window.dispatchEvent(new CustomEvent(FILE_VIEWER_COMMAND_EVENT, { detail: command }));
}

export function onOpenFileViewerCommand(
  listener: (command: FileViewerCommand) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<FileViewerCommand>).detail);
  };
  window.addEventListener(FILE_VIEWER_COMMAND_EVENT, handler);
  return () => window.removeEventListener(FILE_VIEWER_COMMAND_EVENT, handler);
}
