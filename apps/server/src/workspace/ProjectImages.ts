// Coder adaptation of main's exact-file assets: read the current environment image on demand.
// @effect-diagnostics nodeBuiltinImport:off -- Workspace-only Linux filesystem adapter.
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  ProjectImageReadError,
  type ProjectImageReadInput,
  type ProjectImageChunk,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { detectStoredScreenshotMimeType } from "./ScreenshotArtifacts.ts";

const reads = Semaphore.makeUnsafe(3);
const unavailable = () =>
  new ProjectImageReadError({ message: "Image is unavailable or has changed. Retry the image." });
/** The caller must verify that cwd belongs to threadId before invoking this read. */
export const readProjectImage = (
  input: ProjectImageReadInput,
): Effect.Effect<ProjectImageChunk, ProjectImageReadError> =>
  reads.withPermit(
    Effect.tryPromise({
      try: async () => {
        if (
          input.filePath.includes("\\") ||
          input.filePath.includes("\0") ||
          !input.filePath.trim() ||
          /^[a-z][a-z0-9+.-]*:/i.test(input.filePath) ||
          input.filePath.startsWith("//") ||
          !Number.isInteger(input.offset) ||
          input.offset < 0 ||
          (input.offset > 0 && !input.revision) ||
          !Number.isInteger(input.limit) ||
          input.limit <= 0 ||
          input.limit > MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES
        )
          throw unavailable();
        const root = await fs.realpath(input.cwd);
        // Like main's media-file assets, relative paths resolve from the thread root;
        // absolute paths and symlinks name an exact image elsewhere in the workspace machine.
        const requested = input.filePath.startsWith("~/")
          ? path.resolve(homedir(), input.filePath.slice(2))
          : path.resolve(root, input.filePath);
        const resolved = await fs.realpath(requested);
        const before = await fs.lstat(resolved, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) throw unavailable();
        const handle = await fs.open(
          resolved,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          // Linux verifies the actual open file, including a parent replaced during open.
          const openedPath = await fs.realpath(
            process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : resolved,
          );
          if (openedPath !== resolved) throw unavailable();
          const stat = await handle.stat({ bigint: true });
          if (
            !stat.isFile() ||
            stat.ino !== before.ino ||
            stat.dev !== before.dev ||
            stat.size <= 0n ||
            stat.size > BigInt(MAX_SCREENSHOT_ARTIFACT_BYTES)
          )
            throw unavailable();
          const fingerprint = (value: typeof stat) =>
            createHash("sha256")
              .update([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":"))
              .digest("hex");
          const revision = fingerprint(stat);
          if (input.revision && input.revision !== revision) throw unavailable();
          const totalBytes = Number(stat.size);
          const mimeType = await detectStoredScreenshotMimeType(handle, totalBytes);
          const extension = path.extname(input.filePath).toLowerCase();
          if (
            !mimeType ||
            !(mimeType === "image/png"
              ? extension === ".png"
              : mimeType === "image/jpeg"
                ? [".jpg", ".jpeg"].includes(extension)
                : extension === ".webp") ||
            input.offset >= totalBytes
          )
            throw unavailable();
          const bytes = Buffer.alloc(Math.min(input.limit, totalBytes - input.offset));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, input.offset);
          if (
            bytesRead !== bytes.length ||
            fingerprint(await handle.stat({ bigint: true })) !== revision
          )
            throw unavailable();
          const next = input.offset + bytesRead;
          const dimensions = input.offset === 0 ? readImageDimensions(bytes) : null;
          return {
            ...(dimensions ? { dimensions } : {}),
            mimeType,
            offset: input.offset,
            totalBytes,
            dataBase64: bytes.toString("base64"),
            nextOffset: next < totalBytes ? next : null,
            revision,
          };
        } finally {
          await handle.close();
        }
      },
      catch: unavailable,
    }),
  );
