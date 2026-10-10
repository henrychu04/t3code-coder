import {
  MAX_PROJECT_HTML_BYTES,
  MAX_PROJECT_MEDIA_BYTES,
  MAX_PROJECT_PDF_BYTES,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  type ProjectFilesOwner,
  type ProjectImageChunk,
  type ProjectImageReadInput,
} from "@t3tools/contracts";
import type { ImageResourceBlob } from "../components/chat/imageResources";
// Coder: the owner is a persisted thread or, for a draft, its project.
export type ProjectImageTarget = ProjectFilesOwner &
  Pick<ProjectImageReadInput, "cwd" | "filePath">;

// Coder: `pdf` and `html` are the documents the Files surface previews.
export type ProjectMediaKind = "image" | "video" | "audio" | "pdf" | "html";
const MAX_BYTES: Record<ProjectMediaKind, number> = {
  image: MAX_SCREENSHOT_ARTIFACT_BYTES,
  video: MAX_PROJECT_MEDIA_BYTES,
  audio: MAX_PROJECT_MEDIA_BYTES,
  pdf: MAX_PROJECT_PDF_BYTES,
  html: MAX_PROJECT_HTML_BYTES,
};
const acceptsMimeType = (kind: ProjectMediaKind, mimeType: string) =>
  kind === "pdf"
    ? mimeType === "application/pdf"
    : kind === "html"
      ? mimeType === "text/html"
      : mimeType.startsWith(`${kind}/`);

export function readProjectImageBlob(
  target: ProjectImageTarget,
  read: (input: ProjectImageReadInput) => Promise<ProjectImageChunk>,
  signal: AbortSignal,
): Promise<ImageResourceBlob> {
  return readProjectMediaBlob("image", target, read, signal);
}

/** Assembles one revision of a workspace media file from bounded helper chunks. */
export async function readProjectMediaBlob(
  kind: ProjectMediaKind,
  target: ProjectImageTarget,
  read: (input: ProjectImageReadInput) => Promise<ProjectImageChunk>,
  signal: AbortSignal,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ImageResourceBlob> {
  const maxBytes = MAX_BYTES[kind];
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
      throw new Error(`Invalid ${kind} chunk.`);
    const chunk = Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0));
    const next = offset + chunk.length;
    if (
      !acceptsMimeType(kind, result.mimeType) ||
      result.offset !== offset ||
      result.totalBytes !== first.totalBytes ||
      result.revision !== first.revision ||
      result.mimeType !== first.mimeType ||
      !Number.isInteger(result.totalBytes) ||
      result.totalBytes <= 0 ||
      result.totalBytes > maxBytes ||
      !chunk.length ||
      chunk.length > MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES ||
      next > result.totalBytes ||
      (result.nextOffset !== null && result.nextOffset !== next)
    )
      throw new Error(`Invalid ${kind} chunk.`);
    chunks.push(chunk);
    onProgress?.(next, result.totalBytes);
    if (result.nextOffset === null) {
      if (next !== result.totalBytes) throw new Error(`Incomplete ${kind}.`);
      const blob = new Blob(chunks, { type: first.mimeType });
      return Object.assign(blob, { imageDimensions: first.dimensions });
    }
    offset = next;
  }
}
