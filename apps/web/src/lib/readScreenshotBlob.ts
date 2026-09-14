import {
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  type ScreenshotArtifactReference,
  type ScreenshotArtifactReadInput,
  type ScreenshotArtifactChunk,
} from "@t3tools/contracts";
function decodeBase64Bytes(value: string): ArrayBuffer {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export async function readScreenshotBlob(
  artifact: Omit<ScreenshotArtifactReference, "sizeBytes"> & { sizeBytes?: number },
  source: "artifact" | "attachment",
  readChunk: (input: ScreenshotArtifactReadInput) => Promise<ScreenshotArtifactChunk>,
  signal: AbortSignal,
): Promise<Blob> {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  let totalBytes = artifact.sizeBytes;
  while (true) {
    signal.throwIfAborted();
    const result = await readChunk({
      artifactId: artifact.id,
      source,
      offset,
      limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
    });
    signal.throwIfAborted();
    totalBytes ??= result.totalBytes;
    if (result.dataBase64.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES / 3) * 4)
      throw new Error("Invalid image chunk.");
    const chunk = decodeBase64Bytes(result.dataBase64);
    const nextOffset = offset + chunk.byteLength;
    if (
      result.offset !== offset ||
      result.totalBytes !== totalBytes ||
      !Number.isInteger(totalBytes) ||
      totalBytes <= 0 ||
      totalBytes > MAX_SCREENSHOT_ARTIFACT_BYTES ||
      result.mimeType !== artifact.mimeType ||
      result.artifactId !== artifact.id ||
      chunk.byteLength === 0 ||
      chunk.byteLength > MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES ||
      nextOffset > totalBytes ||
      (result.nextOffset !== null && result.nextOffset !== nextOffset)
    )
      throw new Error("Invalid image chunk.");
    chunks.push(chunk);
    if (result.nextOffset === null) {
      if (nextOffset !== totalBytes) throw new Error("Incomplete image.");
      break;
    }
    offset = nextOffset;
  }
  return new Blob(chunks, { type: artifact.mimeType });
}
