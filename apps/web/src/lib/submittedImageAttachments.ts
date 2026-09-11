import { ScreenshotArtifactId } from "@t3tools/contracts";
import { extractComposerPastedImageAttachmentIds } from "@t3tools/shared/composerTrigger";
import type { ImagePreviewReference } from "../components/chat/ScreenshotArtifactsRow";

/** Recognize only internally generated attachment references, never arbitrary paths. */
export function submittedImageAttachments(text: string) {
  const images: ImagePreviewReference[] = [];
  const seen = new Set<string>();
  const visibleText = text.replace(/\[[^\]\n]*\]\([^\s)]+\)/g, (link) => {
    const id = extractComposerPastedImageAttachmentIds(link)[0];
    if (!id) return link;
    if (!seen.has(id)) {
      seen.add(id);
      images.push({
        id: ScreenshotArtifactId.make(id.replace(/\.[^.]+$/, "")),
        name: `Image ${images.length + 1}`,
        mimeType: id.endsWith(".png")
          ? "image/png"
          : id.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg",
      });
    }
    return "";
  });
  return { text: images.length ? visibleText.trim() : text, images };
}
