// @effect-diagnostics nodeBuiltinImport:off -- Workspace artifact storage is a Linux filesystem adapter.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type AttachmentFileChunk,
  type AttachmentFileReadInput,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  ScreenshotArtifactReadError,
  type ScreenshotArtifactChunk,
  type ScreenshotArtifactMimeType,
  type ScreenshotArtifactReadInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Chat attachment ids, as in contracts; the attachment store resolves them to one file. */
const ATTACHMENT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;

const extensionByMimeType: Record<ScreenshotArtifactMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function detectStoredScreenshotMimeType(
  handle: NodeFS.FileHandle,
  size: number,
): Promise<ScreenshotArtifactMimeType | undefined> {
  const header = Buffer.alloc(Math.min(size, 12));
  const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
  const readableHeader = header.subarray(0, bytesRead);
  if (readableHeader.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (
    size >= 4 &&
    readableHeader[0] === 0xff &&
    readableHeader[1] === 0xd8 &&
    readableHeader[2] === 0xff
  ) {
    const trailer = Buffer.alloc(2);
    const trailerRead = await handle.read(trailer, 0, trailer.byteLength, size - 2);
    if (trailerRead.bytesRead === 2 && trailer[0] === 0xff && trailer[1] === 0xd9) {
      return "image/jpeg";
    }
  }
  if (
    size >= 12 &&
    readableHeader.subarray(0, 4).toString("ascii") === "RIFF" &&
    readableHeader.subarray(8, 12).toString("ascii") === "WEBP" &&
    readableHeader.readUInt32LE(4) + 8 === size
  ) {
    return "image/webp";
  }
  return undefined;
}

export class ScreenshotArtifacts extends Context.Service<
  ScreenshotArtifacts,
  {
    readonly readChunk: (
      input: ScreenshotArtifactReadInput,
    ) => Effect.Effect<ScreenshotArtifactChunk, ScreenshotArtifactReadError>;
    /** Coder: a sent file attachment by id, any type, for its preview and Save. */
    readonly readAttachmentFileChunk: (
      input: AttachmentFileReadInput,
    ) => Effect.Effect<AttachmentFileChunk, ScreenshotArtifactReadError>;
  }
>()("t3/workspace/ScreenshotArtifacts") {}

/** @public Read-only compatibility for submitted attachments and previously captured images. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const readChunk: ScreenshotArtifacts["Service"]["readChunk"] = Effect.fn(
    "ScreenshotArtifacts.readChunk",
  )(function* (input) {
    const isAttachment = input.source === "attachment";
    if (!(isAttachment ? ATTACHMENT_ID_PATTERN : ARTIFACT_ID_PATTERN).test(input.artifactId)) {
      return yield* new ScreenshotArtifactReadError({
        artifactId: input.artifactId,
        message: "Screenshot artifact was not found.",
      });
    }

    const candidate = yield* Effect.tryPromise({
      try: async () => {
        const attachmentPath = isAttachment
          ? resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: input.artifactId,
            })
          : null;
        const candidates: ReadonlyArray<{
          readonly filePath: string;
          readonly mimeType: ScreenshotArtifactMimeType | undefined;
        }> = isAttachment
          ? attachmentPath === null
            ? []
            : [{ filePath: attachmentPath, mimeType: undefined }]
          : (
              Object.entries(extensionByMimeType) as Array<[ScreenshotArtifactMimeType, string]>
            ).map(([mimeType, extension]) => ({
              filePath: NodePath.join(
                config.screenshotArtifactsDir,
                `${input.artifactId}.${extension}`,
              ),
              mimeType,
            }));
        for (const { filePath, mimeType } of candidates) {
          try {
            const handle = await NodeFS.open(
              filePath,
              FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
            );
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCREENSHOT_ARTIFACT_BYTES) {
                return undefined;
              }
              const detectedMimeType = await detectStoredScreenshotMimeType(handle, stat.size);
              if (
                detectedMimeType === undefined ||
                (mimeType !== undefined && detectedMimeType !== mimeType) ||
                input.offset >= stat.size
              ) {
                return undefined;
              }
              const bytesToRead = Math.min(
                input.limit,
                MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
                stat.size - input.offset,
              );
              const buffer = Buffer.allocUnsafe(bytesToRead);
              const { bytesRead } = await handle.read(buffer, 0, bytesToRead, input.offset);
              return {
                mimeType: detectedMimeType,
                totalBytes: stat.size,
                bytes: buffer.subarray(0, bytesRead),
              };
            } finally {
              await handle.close();
            }
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        }
        return undefined;
      },
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));

    if (!candidate || candidate.bytes.byteLength === 0) {
      return yield* new ScreenshotArtifactReadError({
        artifactId: input.artifactId,
        message: "Screenshot artifact was not found.",
      });
    }
    const nextOffset = input.offset + candidate.bytes.byteLength;
    return {
      artifactId: input.artifactId,
      mimeType: candidate.mimeType,
      offset: input.offset,
      totalBytes: candidate.totalBytes,
      dataBase64: candidate.bytes.toString("base64"),
      nextOffset: nextOffset < candidate.totalBytes ? nextOffset : null,
    } satisfies ScreenshotArtifactChunk;
  });

  const readAttachmentFileChunk: ScreenshotArtifacts["Service"]["readAttachmentFileChunk"] =
    Effect.fn("ScreenshotArtifacts.readAttachmentFileChunk")(function* (input) {
      const notFound = new ScreenshotArtifactReadError({
        artifactId: input.attachmentId,
        message: "Attachment was not found.",
      });
      const filePath = ATTACHMENT_ID_PATTERN.test(input.attachmentId)
        ? resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: input.attachmentId,
          })
        : null;
      if (filePath === null) return yield* notFound;
      const chunk = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFS.open(
            filePath,
            FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
          );
          try {
            const stat = await handle.stat();
            if (
              !stat.isFile() ||
              stat.size === 0 ||
              stat.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
              input.offset >= stat.size
            ) {
              return undefined;
            }
            const bytesToRead = Math.min(
              input.limit,
              MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
              stat.size - input.offset,
            );
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const { bytesRead } = await handle.read(buffer, 0, bytesToRead, input.offset);
            return { totalBytes: stat.size, bytes: buffer.subarray(0, bytesRead) };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (!chunk || chunk.bytes.byteLength === 0) return yield* notFound;
      const nextOffset = input.offset + chunk.bytes.byteLength;
      return {
        offset: input.offset,
        totalBytes: chunk.totalBytes,
        dataBase64: chunk.bytes.toString("base64"),
        nextOffset: nextOffset < chunk.totalBytes ? nextOffset : null,
      } satisfies AttachmentFileChunk;
    });

  return ScreenshotArtifacts.of({ readChunk, readAttachmentFileChunk });
});

export const layer = Layer.effect(ScreenshotArtifacts, make);
