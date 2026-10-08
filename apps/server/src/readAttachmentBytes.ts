// @effect-diagnostics nodeBuiltinImport:off -- Attachments live in the Linux workspace.
import type { FileHandle } from "node:fs/promises";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

/** Bounds allocation and reads even if another workspace process grows the opened file. */
export async function readAttachmentBytes(
  handle: Pick<FileHandle, "read">,
  sizeBytes: number,
  maxBytes: number = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) {
    throw new Error("Attachment size is invalid.");
  }
  const bytes = Buffer.alloc(sizeBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== sizeBytes) throw new Error("Attachment changed while reading.");
  return bytes.subarray(0, sizeBytes);
}
