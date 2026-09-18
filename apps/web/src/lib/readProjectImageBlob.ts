import {
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  type ProjectImageChunk,
  type ProjectImageReadInput,
} from "@t3tools/contracts";
import type { ImageResourceBlob } from "../components/chat/imageResources";
export type ProjectImageTarget = Pick<ProjectImageReadInput, "threadId" | "cwd" | "filePath">;

export async function readProjectImageBlob(
  target: ProjectImageTarget,
  read: (input: ProjectImageReadInput) => Promise<ProjectImageChunk>,
  signal: AbortSignal,
): Promise<ImageResourceBlob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let first: ProjectImageChunk | undefined;
  while (true) {
    signal.throwIfAborted();
    const result = await read({
      ...target,
      offset,
      limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
      ...(first ? { revision: first.revision } : {}),
    });
    signal.throwIfAborted();
    first ??= result;
    if (result.dataBase64.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES / 3) * 4)
      throw new Error("Invalid image chunk.");
    const chunk = Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0));
    const next = offset + chunk.length;
    if (
      result.offset !== offset ||
      result.totalBytes !== first.totalBytes ||
      result.revision !== first.revision ||
      result.mimeType !== first.mimeType ||
      !Number.isInteger(result.totalBytes) ||
      result.totalBytes <= 0 ||
      result.totalBytes > MAX_SCREENSHOT_ARTIFACT_BYTES ||
      !chunk.length ||
      chunk.length > MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES ||
      next > result.totalBytes ||
      (result.nextOffset !== null && result.nextOffset !== next)
    )
      throw new Error("Invalid image chunk.");
    chunks.push(chunk);
    if (result.nextOffset === null) {
      if (next !== result.totalBytes) throw new Error("Incomplete image.");
      const blob = new Blob(chunks, { type: first.mimeType });
      return Object.assign(blob, { imageDimensions: first.dimensions });
    }
    offset = next;
  }
}
