import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { mediaFileReference, type MediaReference } from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectImageTarget } from "../../lib/readProjectImageBlob";
import { useRightPanelStore } from "../../rightPanelStore";

/** The authored workspace location of helper-read media, for main's copy-path actions. */
export function projectMediaReference(target: ProjectImageTarget): MediaReference {
  // Absolute and home-relative paths already name the file the helper reads.
  const path = /^~?\//.test(target.filePath)
    ? target.filePath
    : `${target.cwd.replace(/\/+$/, "")}/${target.filePath.replace(/^\.\//, "")}`;
  return mediaFileReference(path, target.cwd);
}

/** Main's media-menu fields: the file's location, and the Files panel when it is in the project. */
export function projectMediaActionFields(
  environmentId: EnvironmentId,
  target: ProjectImageTarget,
): { reference: MediaReference; onOpenFile?: () => void } {
  const reference = projectMediaReference(target);
  const relativePath = reference.kind === "file" ? reference.relativePath : undefined;
  // A draft's media names its project, not a thread whose Files panel could open it.
  const threadId = target.threadId;
  return relativePath && threadId
    ? {
        reference,
        onOpenFile: () =>
          useRightPanelStore
            .getState()
            .openFile(scopeThreadRef(environmentId, threadId), relativePath),
      }
    : { reference };
}
