// Coder adaptation of main's exact-file assets: read the current environment media file on demand.
// @effect-diagnostics nodeBuiltinImport:off -- Workspace-only Linux filesystem adapter.
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  MAX_PROJECT_HTML_BYTES,
  MAX_PROJECT_MEDIA_BYTES,
  MAX_PROJECT_PDF_BYTES,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  ProjectImageReadError,
  type ProjectImageReadInput,
  type ProjectImageChunk,
  type ProjectMediaMimeType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { detectStoredScreenshotMimeType } from "./ScreenshotArtifacts.ts";

const reads = Semaphore.makeUnsafe(3);
const ascii = (bytes: Buffer, start: number, end: number) =>
  bytes.subarray(start, end).toString("latin1");

/**
 * Matches the file's signature against the type its extension claims, so a renamed file cannot
 * reach the browser as a different media type. SVG has no binary signature; it must look like
 * markup, and the browser only ever renders it through an image element.
 */
async function detectProjectMediaMimeType(
  handle: fs.FileHandle,
  size: number,
  extension: string,
): Promise<ProjectMediaMimeType | undefined> {
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const mimeType = await detectStoredScreenshotMimeType(handle, size);
    return (
      mimeType === "image/png"
        ? extension === ".png"
        : mimeType === "image/jpeg"
          ? extension !== ".png" && extension !== ".webp"
          : extension === ".webp"
    )
      ? mimeType
      : undefined;
  }
  const header = Buffer.alloc(Math.min(size, 4096));
  const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
  const bytes = header.subarray(0, bytesRead);
  const ftypBrand = bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" ? ascii(bytes, 8, 12) : "";
  switch (extension) {
    case ".gif":
      return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) ? "image/gif" : undefined;
    case ".avif":
      return ftypBrand === "avif" || ftypBrand === "avis" ? "image/avif" : undefined;
    case ".bmp":
      return ascii(bytes, 0, 2) === "BM" ? "image/bmp" : undefined;
    case ".ico":
      return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) ? "image/x-icon" : undefined;
    case ".svg": {
      const text = bytes.toString("utf8");
      return !bytes.includes(0) && /^(?:\uFEFF)?\s*</u.test(text) && text.includes("<svg")
        ? "image/svg+xml"
        : undefined;
    }
    case ".mp4":
    case ".m4v":
      return ftypBrand ? "video/mp4" : undefined;
    case ".mov":
      return ftypBrand || ["moov", "mdat", "wide", "free"].includes(ascii(bytes, 4, 8))
        ? "video/quicktime"
        : undefined;
    case ".webm":
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        ? "video/webm"
        : undefined;
    case ".mkv":
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        ? "video/x-matroska"
        : undefined;
    case ".avi":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "AVI "
        ? "video/x-msvideo"
        : undefined;
    case ".ogv":
      return ascii(bytes, 0, 4) === "OggS" ? "video/ogg" : undefined;
    case ".mp3":
      return ascii(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
        ? "audio/mpeg"
        : undefined;
    case ".wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE"
        ? "audio/wav"
        : undefined;
    case ".ogg":
    case ".oga":
    case ".opus":
      return ascii(bytes, 0, 4) === "OggS" ? "audio/ogg" : undefined;
    case ".flac":
      return ascii(bytes, 0, 4) === "fLaC" ? "audio/flac" : undefined;
    case ".aac":
      return ascii(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0)
        ? "audio/aac"
        : undefined;
    case ".m4a":
      return ftypBrand ? "audio/mp4" : undefined;
    // Coder: documents the Files surface previews; the reader keeps them inside the project.
    case ".pdf":
      return ascii(bytes, 0, 5) === "%PDF-" ? "application/pdf" : undefined;
    case ".html":
    case ".htm":
      return bytes.includes(0) ? undefined : "text/html";
    case ".aiff":
      return ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 12))
        ? "audio/aiff"
        : undefined;
    default:
      return undefined;
  }
}

const unavailable = () =>
  new ProjectImageReadError({ message: "Media is unavailable or has changed. Retry." });
/** The caller must verify that cwd belongs to the request owner before invoking this read. */
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
            stat.size > BigInt(MAX_PROJECT_MEDIA_BYTES)
          )
            throw unavailable();
          const fingerprint = (value: typeof stat) =>
            createHash("sha256")
              .update([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":"))
              .digest("hex");
          const revision = fingerprint(stat);
          if (input.revision && input.revision !== revision) throw unavailable();
          const totalBytes = Number(stat.size);
          const mimeType = await detectProjectMediaMimeType(
            handle,
            totalBytes,
            path.extname(input.filePath).toLowerCase(),
          );
          const isDocument = mimeType === "application/pdf" || mimeType === "text/html";
          if (
            !mimeType ||
            (mimeType.startsWith("image/") && totalBytes > MAX_SCREENSHOT_ARTIFACT_BYTES) ||
            (mimeType === "application/pdf" && totalBytes > MAX_PROJECT_PDF_BYTES) ||
            (mimeType === "text/html" && totalBytes > MAX_PROJECT_HTML_BYTES) ||
            // Coder: documents are previewed only from inside the verified project root.
            (isDocument && !resolved.startsWith(`${root}${path.sep}`)) ||
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
