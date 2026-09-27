import type { ComposerFileAttachment } from "../../composerDraftStore";
import { fileContextReference } from "../../lib/composerContextRecords";

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
} {
  const liveFileContextIds = new Set<string>(
    input.files.map((file) => fileContextReference(file).contextId),
  );
  const filesToRemove: string[] = [];
  for (const file of input.files) {
    const contextId = fileContextReference(file).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.files.set(contextId, file);
    filesToRemove.push(file.id);
  }
  const filesToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveFileContextIds.has(contextId)) return [];
    const file = input.retained.files.get(contextId);
    return file ? [file] : [];
  });

  return { filesToRemove, filesToRestore };
}
