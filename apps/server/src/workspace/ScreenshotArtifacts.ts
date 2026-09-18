// @effect-diagnostics nodeBuiltinImport:off -- Workspace artifact storage is a Linux filesystem adapter.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  ScreenshotArtifactReadError,
  type ScreenshotArtifactChunk,
  type ScreenshotArtifactMimeType,
  type ScreenshotArtifactReadInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  }
>()("t3/workspace/ScreenshotArtifacts") {}

/** @public Read-only compatibility for submitted attachments and previously captured images. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const readChunk: ScreenshotArtifacts["Service"]["readChunk"] = Effect.fn(
    "ScreenshotArtifacts.readChunk",
  )(function* (input) {
    if (!ARTIFACT_ID_PATTERN.test(input.artifactId)) {
      return yield* new ScreenshotArtifactReadError({
        artifactId: input.artifactId,
        message: "Screenshot artifact was not found.",
      });
    }

    const candidate = yield* Effect.tryPromise({
      try: async () => {
        for (const [mimeType, extension] of Object.entries(extensionByMimeType) as Array<
          [ScreenshotArtifactMimeType, string]
        >) {
          const filePath = NodePath.join(
            input.source === "attachment" ? config.attachmentsDir : config.screenshotArtifactsDir,
            `${input.artifactId}.${extension}`,
          );
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
              if (detectedMimeType !== mimeType || input.offset >= stat.size) return undefined;
              const bytesToRead = Math.min(
                input.limit,
                MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
                stat.size - input.offset,
              );
              const buffer = Buffer.allocUnsafe(bytesToRead);
              const { bytesRead } = await handle.read(buffer, 0, bytesToRead, input.offset);
              return {
                mimeType,
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

  return ScreenshotArtifacts.of({ readChunk });
});

export const layer = Layer.effect(ScreenshotArtifacts, make);
