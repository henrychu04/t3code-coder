import { splitPathAndPosition } from "./terminal-links";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRightPanelStore } from "./rightPanelStore";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";
import type { ContextMenuItem } from "./localApiTypes";
import { readLocalApi } from "./localApi";
import { useCopyToClipboard } from "./hooks/useCopyToClipboard";

export type FileContextMenuAction = "copy-path" | "open";
export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

/** Diff paths are repository-relative; the clipboard exposes project-relative paths only. */
export function resolveFileContextMenuRelativePath(target: FileContextMenuTarget): string | null {
  const root = target.workspaceRoot?.replace(/\/+$/, "");
  const path = target.filePath;
  if (!root || !root.startsWith("/") || !path || /[\0\\]/.test(path) || /^[A-Za-z]:/.test(path))
    return null;
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  const repositoryRoot = target.repositoryRoot?.replace(/\/+$/, "") ?? root;
  const absolute = `${repositoryRoot}/${path}`;
  if (!absolute.startsWith(`${root}/`)) return null;
  const relative = absolute.slice(root.length + 1);
  return relative.split("/").some((part) => !part || part === "." || part === "..")
    ? null
    : relative;
}

/** Composer mentions are explicit file paths, so extensionless names are valid too. */
export function resolveComposerFileTarget(filePath: string, workspaceRoot: string | null) {
  const root = workspaceRoot?.replace(/\/+$/, "");
  if (!root) return null;
  const { path, line } = splitPathAndPosition(filePath);
  const relative = path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path.replace(/^\.\//, "");
  const relativePath = resolveFileContextMenuRelativePath({
    environmentId: null,
    workspaceRoot: root,
    filePath: relative,
  });
  if (!relativePath) return null;
  const lineNumber = line ? Number.parseInt(line, 10) : undefined;
  return { relativePath, line: lineNumber };
}

export function buildFileContextMenuItems(
  target: FileContextMenuTarget,
  canOpen = false,
): readonly ContextMenuItem<FileContextMenuAction>[] {
  return resolveFileContextMenuRelativePath(target) === null
    ? []
    : [
        ...(canOpen
          ? [{ id: "open" as const, label: "Open in Files", icon: "file" as const }]
          : []),
        { id: "copy-path", label: "Copy path", icon: "copy" },
      ];
}

export function useFileContextMenuHandler(
  environmentId: EnvironmentId | null,
  threadRef?: ScopedThreadRef | null,
) {
  const { copyToClipboard } = useCopyToClipboard();
  return useCallback(
    (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
      if (environmentId === null || target.environmentId !== environmentId) return;
      const path = resolveFileContextMenuRelativePath(target);
      const api = readLocalApi();
      if (!path || !api) return;
      void api.contextMenu
        .show(
          buildFileContextMenuItems(target, threadRef?.environmentId === environmentId),
          event ? { x: event.clientX, y: event.clientY } : undefined,
        )
        .then((action) => {
          if (action === "open" && threadRef?.environmentId === environmentId)
            useRightPanelStore.getState().openFile(threadRef, path);
          if (action === "copy-path") copyToClipboard(path, undefined);
        });
    },
    [environmentId, copyToClipboard, threadRef],
  );
}
