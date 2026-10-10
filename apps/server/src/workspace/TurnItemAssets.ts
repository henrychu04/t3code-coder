// @effect-diagnostics nodeBuiltinImport:off -- Captured app documents are Linux workspace files.
/**
 * Coder: upstream serves a stored item's MCP App document and its tool output images through
 * signed asset URLs. The helper has no HTTP listener, so it serves the same bytes as bounded
 * stdio chunks, and only bytes the named item itself references.
 */
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";

import {
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemAssetChunk,
  type TurnItemAssetMimeType,
  TurnItemAssetReadError,
  type TurnItemAssetReadInput,
  type TurnItemId,
} from "@t3tools/contracts";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  mcpAppFromToolItem,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, parseAttachmentUuid } from "../attachmentStore.ts";

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

interface AssetBytes {
  readonly mimeType: TurnItemAssetMimeType;
  readonly totalBytes: number;
  readonly bytes: Buffer;
}

/** One image the item's tool returned inline, decoded within a provider turn's image limit. */
function readToolOutputImage(
  item: OrchestrationV2TurnItem,
  index: number,
  offset: number,
  limit: number,
): AssetBytes | undefined {
  if (item.type !== "dynamic_tool") return undefined;
  const image = toolOutputImages(item.output)[index];
  if (
    image?.data === undefined ||
    image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH ||
    !IMAGE_MIME_TYPES.has(image.mimeType)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(image.data, "base64");
  if (offset >= bytes.byteLength) return undefined;
  return {
    mimeType: image.mimeType as TurnItemAssetMimeType,
    totalBytes: bytes.byteLength,
    bytes: bytes.subarray(offset, offset + limit),
  };
}

/** The captured document of the app the item carries, read without following a symlink. */
async function readMcpAppDocument(
  attachmentsDir: string,
  item: OrchestrationV2TurnItem,
  offset: number,
  limit: number,
): Promise<AssetBytes | undefined> {
  if (item.type !== "dynamic_tool") return undefined;
  const app = mcpAppFromToolItem(item);
  if (
    app === undefined ||
    parseAttachmentUuid(app.attachmentId) === null ||
    parseAttachmentFileExtension(app.attachmentId) !== "html"
  ) {
    return undefined;
  }
  const filePath = resolveAttachmentRelativePath({
    attachmentsDir,
    relativePath: `${app.attachmentId}.html`,
  });
  if (filePath === null) return undefined;
  const handle = await NodeFS.open(
    filePath,
    FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MCP_APP_MAX_HTML_BYTES) return undefined;
    if (offset >= stat.size) return undefined;
    const buffer = Buffer.allocUnsafe(Math.min(limit, stat.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
    return { mimeType: "text/html", totalBytes: stat.size, bytes: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

export const readTurnItemAssetChunk = Effect.fn("TurnItemAssets.readChunk")(function* (
  input: TurnItemAssetReadInput,
  dependencies: {
    readonly attachmentsDir: string;
    readonly getTurnItem: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
    }) => Effect.Effect<OrchestrationV2TurnItem | null, unknown>;
  },
) {
  const limit = Math.min(input.limit, MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES);
  const item = yield* dependencies
    .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
    .pipe(Effect.orElseSucceed(() => null));
  const asset =
    item === null
      ? undefined
      : input.asset._tag === "tool-output-image"
        ? readToolOutputImage(item, input.asset.index, input.offset, limit)
        : yield* Effect.tryPromise(() =>
            readMcpAppDocument(dependencies.attachmentsDir, item, input.offset, limit),
          ).pipe(Effect.orElseSucceed(() => undefined));
  if (asset === undefined || asset.bytes.byteLength === 0) {
    return yield* new TurnItemAssetReadError({ message: "The asset was not found." });
  }
  const nextOffset = input.offset + asset.bytes.byteLength;
  return {
    mimeType: asset.mimeType,
    offset: input.offset,
    totalBytes: asset.totalBytes,
    dataBase64: asset.bytes.toString("base64"),
    nextOffset: nextOffset < asset.totalBytes ? nextOffset : null,
  } satisfies TurnItemAssetChunk;
});
