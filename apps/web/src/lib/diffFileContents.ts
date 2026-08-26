import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ReviewDiffFileChunkInput,
  ReviewDiffFileChunkResult,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffFileSnapshotReference,
  ReviewDiffFileSnapshotResult,
  ReviewDiffFileTooLargeError,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";
import { MAX_REVIEW_DIFF_FILE_CHUNK_BYTES } from "@t3tools/contracts";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** The comparison identity Pierre carries into its hydrated render cache. */
  readonly cacheKey: string;
}

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type OpenDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileSnapshotResult, E>>;

type ReadDiffFileChunk<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileChunkInput;
}) => Promise<AtomCommandResult<ReviewDiffFileChunkResult, E>>;

const DIFF_FILE_CONTENTS_CACHE_BYTES = 64 * 1024 * 1024;
const DIFF_FILE_CONTENTS_CACHE_ENTRIES = 128;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const diffFileContentsCache = new Map<
  string,
  {
    readonly contents: { readonly oldContents: string; readonly newContents: string };
    readonly bytes: number;
  }
>();
let diffFileContentsCacheBytes = 0;

export function getDiffFileTooLargeMaxBytes(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "ReviewDiffFileTooLargeError" ||
    !("maxBytes" in error) ||
    typeof error.maxBytes !== "number" ||
    !Number.isSafeInteger(error.maxBytes) ||
    error.maxBytes <= 0
  ) {
    return null;
  }
  return (error as ReviewDiffFileTooLargeError).maxBytes;
}

export function withDiffFileTooLargeReporting(
  load: FileDiffContentsLoader,
  report: (fileDiff: Parameters<FileDiffContentsLoader>[0], maxBytes: number) => void,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    try {
      return await load(fileDiff);
    } catch (error) {
      const maxBytes = getDiffFileTooLargeMaxBytes(error);
      if (maxBytes !== null) report(fileDiff, maxBytes);
      throw error;
    }
  };
}

function readCachedDiffFileContents(key: string) {
  const cached = diffFileContentsCache.get(key);
  if (!cached) return null;
  diffFileContentsCache.delete(key);
  diffFileContentsCache.set(key, cached);
  return cached.contents;
}

function cacheDiffFileContents(
  key: string,
  contents: { readonly oldContents: string; readonly newContents: string },
): void {
  const existing = diffFileContentsCache.get(key);
  if (existing) {
    diffFileContentsCache.delete(key);
    diffFileContentsCacheBytes -= existing.bytes;
  }
  const bytes =
    textEncoder.encode(contents.oldContents).byteLength +
    textEncoder.encode(contents.newContents).byteLength;
  while (
    diffFileContentsCache.size > 0 &&
    (diffFileContentsCache.size >= DIFF_FILE_CONTENTS_CACHE_ENTRIES ||
      diffFileContentsCacheBytes + bytes > DIFF_FILE_CONTENTS_CACHE_BYTES)
  ) {
    const oldestKey = diffFileContentsCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = diffFileContentsCache.get(oldestKey);
    diffFileContentsCache.delete(oldestKey);
    diffFileContentsCacheBytes -= oldest?.bytes ?? 0;
  }
  if (bytes > DIFF_FILE_CONTENTS_CACHE_BYTES) return;
  diffFileContentsCache.set(key, { contents, bytes });
  diffFileContentsCacheBytes += bytes;
}

function diffFileContentsCacheNamespace(source: GitDiffFileContentsSource): string {
  return JSON.stringify([
    source.environmentId,
    source.cwd,
    source.sourceKind,
    source.baseRef,
    source.headRef,
    source.cacheKey,
  ]);
}

function decodeBase64Chunk(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function decodeDiffFileChunk(result: ReviewDiffFileChunkResult): Promise<Uint8Array> {
  const encoded = decodeBase64Chunk(result.dataBase64);
  if (result.encoding === "base64") return encoded;
  const stream = new Blob([encoded.slice().buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: ReviewDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

/** Turns the host's Git file-content RPC into the full-file loader Pierre uses for hunk expansion. */
export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  const cacheNamespace = diffFileContentsCacheNamespace(source);
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, cacheNamespace);
}

/** Loads immutable workspace file snapshots in bounded RPC chunks and retains completed files in memory. */
export function createChunkedGitDiffFileContentsLoader<E>(
  openDiffFileContents: OpenDiffFileContents<E>,
  readDiffFileChunk: ReadDiffFileChunk<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  const cacheNamespace = diffFileContentsCacheNamespace(source);
  const readSnapshot = async (
    snapshot: ReviewDiffFileSnapshotReference | null,
  ): Promise<string> => {
    if (snapshot === null || snapshot.totalBytes === 0) return "";
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let offset = 0;
    while (offset < snapshot.totalBytes) {
      const result = await readDiffFileChunk({
        environmentId: source.environmentId,
        input: {
          snapshotId: snapshot.snapshotId,
          offset,
          limit: MAX_REVIEW_DIFF_FILE_CHUNK_BYTES,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const chunk = await decodeDiffFileChunk(result.value);
      const nextOffset = offset + chunk.byteLength;
      if (
        result.value.snapshotId !== snapshot.snapshotId ||
        result.value.offset !== offset ||
        result.value.totalBytes !== snapshot.totalBytes ||
        result.value.decodedBytes !== chunk.byteLength ||
        chunk.byteLength === 0 ||
        nextOffset > snapshot.totalBytes ||
        (result.value.nextOffset !== null && result.value.nextOffset !== nextOffset)
      ) {
        throw new Error("Invalid review file chunk.");
      }
      chunks.push(chunk);
      receivedBytes += chunk.byteLength;
      if (result.value.nextOffset === null) break;
      offset = result.value.nextOffset;
    }
    if (receivedBytes !== snapshot.totalBytes) throw new Error("Incomplete review file snapshot.");
    const combined = new Uint8Array(receivedBytes);
    let writeOffset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    if ((await sha256Hex(combined)) !== snapshot.contentHash) {
      throw new Error("Invalid review file snapshot hash.");
    }
    return textDecoder.decode(combined);
  };

  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const cacheKey = JSON.stringify([cacheNamespace, changeType, oldPath, newPath]);
    const cached = readCachedDiffFileContents(cacheKey);
    if (cached) return cached;
    const opened = await openDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (opened._tag !== "Success") throw squashAtomCommandFailure(opened);
    const [oldContents, newContents] = await Promise.all([
      readSnapshot(opened.value.oldFile),
      readSnapshot(opened.value.newFile),
    ]);
    const contents = { oldContents, newContents };
    cacheDiffFileContents(cacheKey, contents);
    return contents;
  }, cacheNamespace);
}
