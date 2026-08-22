// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CoderClipboardImageExtension } from "@t3tools/coder-cli/scp";

export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ClipboardImageValidationError extends Error {}

export function validateClipboardImage(
  contentType: string,
  bytes: Buffer,
): CoderClipboardImageExtension {
  if (bytes.byteLength === 0) {
    throw new ClipboardImageValidationError("Clipboard image is empty.");
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageValidationError("Clipboard image exceeds the 20 MiB limit.");
  }
  if (
    contentType === "image/png" &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return "png";
  }
  if (
    contentType === "image/jpeg" &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return "jpg";
  }
  if (
    contentType === "image/webp" &&
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.byteLength
  ) {
    return "webp";
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new ClipboardImageValidationError("Clipboard image must be PNG, JPEG, or WebP.");
  }
  throw new ClipboardImageValidationError("Clipboard image content does not match its media type.");
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
