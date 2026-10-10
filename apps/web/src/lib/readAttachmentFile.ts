/**
 * Coder: reads a sent file attachment by id through the helper's bounded chunks, where upstream
 * loads a signed attachment asset URL.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type AttachmentFileChunk,
  type AttachmentFileReadInput,
  type EnvironmentId,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ScreenshotArtifactId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

function decodeBase64Bytes(value: string): ArrayBuffer {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export async function readAttachmentFile(
  attachmentId: ScreenshotArtifactId,
  mimeType: string,
  readChunk: (input: AttachmentFileReadInput) => Promise<AttachmentFileChunk>,
  signal?: AbortSignal,
): Promise<Blob> {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  let totalBytes: number | undefined;
  while (true) {
    signal?.throwIfAborted();
    const result = await readChunk({
      attachmentId,
      offset,
      limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
    });
    signal?.throwIfAborted();
    totalBytes ??= result.totalBytes;
    if (result.dataBase64.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES / 3) * 4)
      throw new Error("Invalid attachment chunk.");
    const chunk = decodeBase64Bytes(result.dataBase64);
    const nextOffset = offset + chunk.byteLength;
    if (
      result.offset !== offset ||
      result.totalBytes !== totalBytes ||
      totalBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
      chunk.byteLength === 0 ||
      nextOffset > totalBytes ||
      (result.nextOffset !== null && result.nextOffset !== nextOffset)
    )
      throw new Error("Invalid attachment chunk.");
    chunks.push(chunk);
    if (result.nextOffset === null) {
      if (nextOffset !== totalBytes) throw new Error("Incomplete attachment.");
      return new Blob(chunks, { type: mimeType });
    }
    offset = nextOffset;
  }
}

/** Reads a sent file attachment of one workspace into memory. */
export function useReadAttachmentFile(environmentId: EnvironmentId) {
  const readChunk = useAtomCommand(projectEnvironment.readAttachmentFile, {
    reportFailure: false,
  });
  return useCallback(
    (
      attachment: { readonly id: string; readonly mimeType: string },
      signal?: AbortSignal,
    ): Promise<Blob> =>
      readAttachmentFile(
        ScreenshotArtifactId.make(attachment.id),
        attachment.mimeType,
        async (input) => {
          const result = await readChunk({ environmentId, input });
          if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          return result.value;
        },
        signal,
      ),
    [environmentId, readChunk],
  );
}

/** Saves bytes the browser already holds through its own download, which asks where when set to. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give it time to start.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
