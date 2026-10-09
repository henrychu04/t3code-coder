import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { attachmentFileExtension } from "@t3tools/shared/attachmentFileExtension";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

/** Writes the bytes to a private temporary file for one transfer, then deletes it. */
export async function withStagedAttachment<T>(
  bytes: Buffer,
  extension: string,
  action: (localPath: string) => Promise<T>,
): Promise<T> {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-attachment-"));
  const localPath = NodePath.join(directory, `${randomUUID()}.${extension}`);
  try {
    await NodeFS.writeFile(localPath, bytes, { mode: 0o600 });
    return await action(localPath);
  } finally {
    await NodeFS.rm(directory, { recursive: true, force: true });
  }
}
