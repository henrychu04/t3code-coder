/**
 * Coder: reads an asset a stored turn item names (its MCP App document or a tool output image)
 * through the helper's bounded chunks, where upstream loads a signed asset URL.
 */
import {
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  MAX_TURN_ITEM_ASSET_BYTES,
  type TurnItemAssetChunk,
  type TurnItemAssetMimeType,
  type TurnItemAssetReadInput,
} from "@t3tools/contracts";

function decodeBase64Bytes(value: string): ArrayBuffer {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export async function readTurnItemAsset(
  target: Omit<TurnItemAssetReadInput, "offset" | "limit">,
  accepts: (mimeType: TurnItemAssetMimeType) => boolean,
  readChunk: (input: TurnItemAssetReadInput) => Promise<TurnItemAssetChunk>,
  signal: AbortSignal,
): Promise<Blob> {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  let first: TurnItemAssetChunk | undefined;
  while (true) {
    signal.throwIfAborted();
    const result = await readChunk({
      ...target,
      offset,
      limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
    });
    signal.throwIfAborted();
    first ??= result;
    if (result.dataBase64.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES / 3) * 4)
      throw new Error("Invalid asset chunk.");
    const chunk = decodeBase64Bytes(result.dataBase64);
    const nextOffset = offset + chunk.byteLength;
    if (
      result.offset !== offset ||
      result.totalBytes !== first.totalBytes ||
      result.mimeType !== first.mimeType ||
      !accepts(result.mimeType) ||
      result.totalBytes > MAX_TURN_ITEM_ASSET_BYTES ||
      chunk.byteLength === 0 ||
      nextOffset > result.totalBytes ||
      (result.nextOffset !== null && result.nextOffset !== nextOffset)
    )
      throw new Error("Invalid asset chunk.");
    chunks.push(chunk);
    if (result.nextOffset === null) {
      if (nextOffset !== result.totalBytes) throw new Error("Incomplete asset.");
      return new Blob(chunks, { type: result.mimeType });
    }
    offset = nextOffset;
  }
}
