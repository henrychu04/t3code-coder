import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { useCopyToClipboard } from "./hooks/useCopyToClipboard";
import { readLocalApi } from "./localApi";
import type { ContextMenuItem } from "./localApiTypes";
import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

// Coder: upstream's reveal, open, and open-with actions need a local editor or file manager, so
// the menu opens the file in the Files surface and copies its path instead.
export type FileContextMenuAction = "copy-path" | "open";

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

function buildFileContextMenuItems(
  target: FileContextMenuTarget,
  canOpen = false,
): readonly ContextMenuItem<FileContextMenuAction>[] {
  if (resolveFileContextMenuAbsolutePath(target) === null) return [];
  return [
    ...(canOpen ? [{ id: "open" as const, label: "Open in Files", icon: "file" as const }] : []),
    { id: "copy-path", label: "Copy path", icon: "copy" },
  ];
}

export function useFileContextMenu(_environmentId: EnvironmentId | null) {
  const { copyToClipboard } = useCopyToClipboard({ target: "path" });
  return {
    buildItems: (target: FileContextMenuTarget) => buildFileContextMenuItems(target),
    activate: async (action: FileContextMenuAction, target: FileContextMenuTarget) => {
      const absolutePath = resolveFileContextMenuAbsolutePath(target);
      if (action === "copy-path" && absolutePath) copyToClipboard(absolutePath, undefined);
    },
  };
}

// Coder: the thread, when given, lets the menu open the file in its Files surface.
export function useFileContextMenuHandler(
  environmentId: EnvironmentId | null,
  threadRef?: ScopedThreadRef | null,
) {
  const contextMenu = useFileContextMenu(environmentId);
  return (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
    const api = readLocalApi();
    const canOpen = threadRef != null && threadRef.environmentId === environmentId;
    const items = buildFileContextMenuItems(target, canOpen);
    if (environmentId === null || items.length === 0 || api === undefined) return;
    void api.contextMenu
      .show(items, event ? { x: event.clientX, y: event.clientY } : undefined)
      .then((clicked) => {
        if (clicked === "open" && canOpen) {
          const workspaceFilePath = resolveDiffPathForWorkspace({
            filePath: target.filePath,
            workspaceRoot: target.workspaceRoot,
            repositoryRoot: target.repositoryRoot,
          });
          if (workspaceFilePath)
            useRightPanelStore.getState().openFile(threadRef, workspaceFilePath);
          return;
        }
        if (clicked === "copy-path") void contextMenu.activate(clicked, target);
      });
  };
}
