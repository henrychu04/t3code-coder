import { detectImageMimeType } from "@t3tools/shared/imageSignature";
// @effect-diagnostics nodeBuiltinImport:off -- Workspace artifact storage is a Linux filesystem adapter.
import { createHash, randomUUID } from "node:crypto";
import { constants as FILE_SYSTEM_CONSTANTS, watch as watchFileSystem } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACTS_PER_TURN,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  ScreenshotArtifactId,
  ScreenshotArtifactReadError,
  type ScreenshotArtifactChunk,
  type ScreenshotArtifactMimeType,
  type ScreenshotArtifactReadInput,
  type ScreenshotArtifactReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_OBSERVED_PATHS = 100;
const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_SCREENSHOT_ARTIFACT_BYTES / 3) * 4 + 4;
const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const extensionByMimeType: Record<ScreenshotArtifactMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface CapturedScreenshotArtifact {
  readonly reference: ScreenshotArtifactReference;
  readonly digest: string;
}

export interface ScreenshotObservation {
  /** Stops the observer and returns the bounded set of image paths it saw. */
  readonly close: () => ReadonlyArray<string>;
}

export function isScreenshotCandidatePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === ".git" || segment === "node_modules")) {
    return false;
  }
  return /\.(?:jpe?g|png|webp)$/i.test(normalized);
}

async function detectStoredScreenshotMimeType(
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

function safeArtifactName(value: string | undefined, mimeType: ScreenshotArtifactMimeType): string {
  const fallback = `screenshot.${extensionByMimeType[mimeType]}`;
  if (!value) return fallback;
  const normalized = NodePath.basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : fallback;
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`);
}

function isPathAtOrWithinRoot(root: string, candidate: string): boolean {
  return (
    NodePath.resolve(root) === NodePath.resolve(candidate) || isPathWithinRoot(root, candidate)
  );
}

export class ScreenshotArtifacts extends Context.Service<
  ScreenshotArtifacts,
  {
    readonly captureFile: (input: {
      readonly cwd: string;
      readonly filePath: string;
      readonly capturedDigests?: ReadonlySet<string> | undefined;
    }) => Effect.Effect<CapturedScreenshotArtifact | undefined>;
    readonly captureBase64: (input: {
      readonly dataBase64: string;
      readonly capturedDigests?: ReadonlySet<string> | undefined;
      readonly mimeType: string;
      readonly name?: string;
    }) => Effect.Effect<CapturedScreenshotArtifact | undefined>;
    readonly observeTurn: (cwd: string) => Effect.Effect<ScreenshotObservation>;
    readonly readChunk: (
      input: ScreenshotArtifactReadInput,
    ) => Effect.Effect<ScreenshotArtifactChunk, ScreenshotArtifactReadError>;
  }
>()("t3/workspace/ScreenshotArtifacts") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const persistBytes = Effect.fn("ScreenshotArtifacts.persistBytes")(function* (input: {
    readonly bytes: Buffer;
    readonly capturedDigests?: ReadonlySet<string> | undefined;
    readonly mimeType?: string;
    readonly name?: string;
  }) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SCREENSHOT_ARTIFACT_BYTES) {
      return undefined;
    }
    const detectedMimeType = detectImageMimeType(input.bytes);
    if (!detectedMimeType || (input.mimeType && input.mimeType !== detectedMimeType)) {
      return undefined;
    }

    const digest = createHash("sha256").update(input.bytes).digest("hex");
    if (
      input.capturedDigests &&
      (input.capturedDigests.size >= MAX_SCREENSHOT_ARTIFACTS_PER_TURN ||
        input.capturedDigests.has(digest))
    )
      return undefined;

    const id = ScreenshotArtifactId.make(randomUUID());
    const extension = extensionByMimeType[detectedMimeType];
    const finalPath = NodePath.join(config.screenshotArtifactsDir, `${id}.${extension}`);
    const temporaryPath = `${finalPath}.tmp`;
    const persisted = yield* Effect.tryPromise({
      try: async () => {
        await NodeFS.mkdir(config.screenshotArtifactsDir, { recursive: true, mode: 0o700 });
        await NodeFS.chmod(config.screenshotArtifactsDir, 0o700);
        await NodeFS.writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
        await NodeFS.rename(temporaryPath, finalPath);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
      Effect.ensuring(
        Effect.promise(() => NodeFS.rm(temporaryPath, { force: true })).pipe(Effect.ignore),
      ),
    );
    if (!persisted) return undefined;

    return {
      reference: {
        id,
        name: safeArtifactName(input.name, detectedMimeType),
        mimeType: detectedMimeType,
        sizeBytes: input.bytes.byteLength,
      },
      digest,
    } satisfies CapturedScreenshotArtifact;
  });

  const captureFile: ScreenshotArtifacts["Service"]["captureFile"] = Effect.fn(
    "ScreenshotArtifacts.captureFile",
  )(function* (input) {
    return yield* Effect.tryPromise({
      try: async () => {
        const root = await NodeFS.realpath(input.cwd);
        const requestedPath = NodePath.isAbsolute(input.filePath)
          ? NodePath.resolve(input.filePath)
          : NodePath.resolve(root, input.filePath);
        const requestedStat = await NodeFS.lstat(requestedPath);
        if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) return undefined;
        if (requestedStat.size === 0 || requestedStat.size > MAX_SCREENSHOT_ARTIFACT_BYTES) {
          return undefined;
        }
        const resolvedPath = await NodeFS.realpath(requestedPath);
        if (!isPathWithinRoot(root, resolvedPath)) return undefined;
        if (isPathAtOrWithinRoot(config.screenshotArtifactsDir, resolvedPath)) return undefined;
        return {
          bytes: await NodeFS.readFile(resolvedPath),
          name: NodePath.basename(resolvedPath),
        };
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.flatMap((candidate) =>
        candidate
          ? persistBytes({ ...candidate, capturedDigests: input.capturedDigests })
          : Effect.succeed(undefined),
      ),
    );
  });

  const captureBase64: ScreenshotArtifacts["Service"]["captureBase64"] = Effect.fn(
    "ScreenshotArtifacts.captureBase64",
  )(function* (input) {
    if (input.dataBase64.length === 0 || input.dataBase64.length > MAX_BASE64_IMAGE_CHARS) {
      return undefined;
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    return yield* persistBytes({
      bytes,
      capturedDigests: input.capturedDigests,
      mimeType: input.mimeType,
      ...(input.name ? { name: input.name } : {}),
    });
  });

  const observeTurn: ScreenshotArtifacts["Service"]["observeTurn"] = (cwd) =>
    Effect.sync(() => {
      const paths = new Set<string>();
      let closed = false;
      try {
        const watcher = watchFileSystem(cwd, { recursive: true }, (_eventType, filename) => {
          if (closed || !filename || paths.size >= MAX_OBSERVED_PATHS) return;
          const relativePath = filename.toString();
          if (!isScreenshotCandidatePath(relativePath)) return;
          const resolvedPath = NodePath.resolve(cwd, relativePath);
          if (isPathAtOrWithinRoot(config.screenshotArtifactsDir, resolvedPath)) return;
          paths.add(resolvedPath);
        });
        watcher.on("error", () => {
          closed = true;
          watcher.close();
        });
        return {
          close: () => {
            if (!closed) {
              closed = true;
              watcher.close();
            }
            return [...paths];
          },
        } satisfies ScreenshotObservation;
      } catch {
        return { close: () => [] } satisfies ScreenshotObservation;
      }
    });

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
            config.screenshotArtifactsDir,
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

  return ScreenshotArtifacts.of({ captureFile, captureBase64, observeTurn, readChunk });
});

export const layer = Layer.effect(ScreenshotArtifacts, make);
