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
    diffFileContentsCacheBytes + bytes > DIFF_FILE_CONTENTS_CACHE_BYTES
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

function decodeBase64Chunk(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
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
  }, source.cacheKey);
}

/** Loads immutable workspace file snapshots in bounded RPC chunks and retains completed files in memory. */
export function createChunkedGitDiffFileContentsLoader<E>(
  openDiffFileContents: OpenDiffFileContents<E>,
  readDiffFileChunk: ReadDiffFileChunk<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
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
      const chunk = decodeBase64Chunk(result.value.dataBase64);
      const nextOffset = offset + chunk.byteLength;
      if (
        result.value.snapshotId !== snapshot.snapshotId ||
        result.value.offset !== offset ||
        result.value.totalBytes !== snapshot.totalBytes ||
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
    return textDecoder.decode(combined);
  };

  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const cacheKey = `${source.cacheKey}:${changeType}:${oldPath}:${newPath}`;
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
  }, source.cacheKey);
}
