import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { buildMessageContext, fileContextReference } from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const file = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
} satisfies ComposerFileAttachment;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores file bytes after deleting and undoing its chip", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [file],
      retained,
    });
    expect(removed.filesToRemove).toEqual(["file-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([fileContextReference(file).contextId]),
      files: [],
      retained,
    });
    expect(restored.filesToRestore).toEqual([file]);
    expect(restored.filesToRestore[0]?.file).toBe(file.file);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        attachments: [{ attachment: restored.filesToRestore[0]!, attachmentId: "uploaded-file" }],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "file",
        contextId: "file_file-1",
        attachmentId: "uploaded-file",
      }),
    ]);
  });
});
