import { ScreenshotArtifactId, type ChatAttachment } from "@t3tools/contracts";
import { extractComposerPastedImageAttachmentIds } from "@t3tools/shared/composerTrigger";
import type { ImagePreviewReference } from "../components/chat/ScreenshotArtifactsRow";

/**
 * Removes links to internally generated attachment files from sent prompts; the images render
 * from the message's attachments. Other links, including arbitrary paths, stay as written.
 */
export function stripSubmittedImageLinks(text: string): string {
  let stripped = false;
  const visibleText = text.replace(/\[[^\]\n]*\]\([^\s)]+\)/g, (link) => {
    if (!extractComposerPastedImageAttachmentIds(link)[0]) return link;
    stripped = true;
    return "";
  });
  return stripped ? visibleText.trim() : text;
}

/** The message's image attachments, read by id through the helper's bounded chunk RPC. */
export function messageImageReferences(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ImagePreviewReference[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.type === "image" &&
    (attachment.mimeType === "image/png" ||
      attachment.mimeType === "image/jpeg" ||
      attachment.mimeType === "image/webp")
      ? [
          {
            id: ScreenshotArtifactId.make(attachment.id),
            name: attachment.name,
            mimeType: attachment.mimeType,
            ...(attachment.sizeBytes > 0 ? { sizeBytes: attachment.sizeBytes } : {}),
          },
        ]
      : [],
  );
}
