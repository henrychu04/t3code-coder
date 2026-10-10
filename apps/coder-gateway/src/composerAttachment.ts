import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { attachmentFileExtension } from "@t3tools/shared/attachmentFileExtension";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";

export const MAX_CLIPBOARD_IMAGE_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
export const MAX_COMPOSER_FILE_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

export type ClipboardImageExtension = "jpg" | "png" | "webp";

export const CLIPBOARD_IMAGE_MIME_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const satisfies Record<ClipboardImageExtension, string>;

export class ComposerAttachmentValidationError extends Error {}

export function validateClipboardImage(contentType: string, bytes: Buffer): ClipboardImageExtension {
  if (bytes.byteLength === 0) {
    throw new ComposerAttachmentValidationError("Image is empty.");
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ComposerAttachmentValidationError("Image exceeds the 10 MiB limit.");
  }
  const detected = detectImageMimeType(bytes);
  if (detected === contentType) {
    return detected === "image/png" ? "png" : detected === "image/jpeg" ? "jpg" : "webp";
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new ComposerAttachmentValidationError("Image must be PNG, JPEG, or WebP.");
  }
  throw new ComposerAttachmentValidationError("Image content does not match its media type.");
}

/**
 * Validates a composer file and returns the extension it is staged under. Any non-empty file up
 * to the provider file limit is accepted; its name contributes only the extension the helper's
 * claim expects, never a path.
 */
export function validateComposerFile(name: string, bytes: Buffer): string {
  if (bytes.byteLength === 0) {
    throw new ComposerAttachmentValidationError("File is empty.");
  }
  if (bytes.byteLength > MAX_COMPOSER_FILE_BYTES) {
    throw new ComposerAttachmentValidationError("File exceeds the 50 MiB limit.");
  }
  return attachmentFileExtension(name).slice(1);
}
