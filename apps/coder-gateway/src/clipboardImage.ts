import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CoderClipboardImageExtension } from "@t3tools/coder-cli/scp";

export const MAX_CLIPBOARD_IMAGE_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

export class ClipboardImageValidationError extends Error {}

export function validateClipboardImage(
  contentType: string,
  bytes: Buffer,
): CoderClipboardImageExtension {
  if (bytes.byteLength === 0) {
    throw new ClipboardImageValidationError("Image is empty.");
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageValidationError("Image exceeds the 10 MiB limit.");
  }
  const detected = detectImageMimeType(bytes);
  if (detected === contentType) {
    return detected === "image/png" ? "png" : detected === "image/jpeg" ? "jpg" : "webp";
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new ClipboardImageValidationError("Image must be PNG, JPEG, or WebP.");
  }
  throw new ClipboardImageValidationError("Image content does not match its media type.");
}

export async function withStagedClipboardImage<T>(
  bytes: Buffer,
  extension: CoderClipboardImageExtension,
  action: (localPath: string) => Promise<T>,
): Promise<T> {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-image-"));
  const localPath = NodePath.join(directory, `${randomUUID()}.${extension}`);
  try {
    await NodeFS.writeFile(localPath, bytes, { mode: 0o600 });
    return await action(localPath);
  } finally {
    await NodeFS.rm(directory, { recursive: true, force: true });
  }
}
