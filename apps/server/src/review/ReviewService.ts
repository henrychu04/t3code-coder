import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import {
  GitCommandError,
  MAX_REVIEW_DIFF_FILE_BYTES,
  type ReviewDiffFileChunkInput,
  type ReviewDiffFileChunkResult,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffFileSnapshotResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    readonly openDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileSnapshotResult, ReviewDiffPreviewError>;
    readonly readDiffFileChunk: (
      input: ReviewDiffFileChunkInput,
    ) => Effect.Effect<ReviewDiffFileChunkResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const snapshotCache = new Map<string, { readonly data: Buffer; readonly expiresAt: number }>();
  let snapshotCacheBytes = 0;
  const snapshotCacheByteLimit = 64 * 1024 * 1024;
  const snapshotCacheEntryLimit = 256;
  const snapshotCacheTtlMs = 2 * 60_000;

  const removeSnapshot = (snapshotId: string) => {
    const snapshot = snapshotCache.get(snapshotId);
    if (!snapshot) return;
    snapshotCache.delete(snapshotId);
    snapshotCacheBytes -= snapshot.data.byteLength;
  };

  const pruneExpiredSnapshots = (now: number) => {
    for (const [snapshotId, snapshot] of snapshotCache) {
      if (snapshot.expiresAt <= now) removeSnapshot(snapshotId);
    }
  };

  const cacheSnapshot = (contents: string) => {
    const now = Date.now();
    pruneExpiredSnapshots(now);
    const data = Buffer.from(contents, "utf8");
    if (data.byteLength > MAX_REVIEW_DIFF_FILE_BYTES) {
      throw new GitCommandError({
        operation: "ReviewService.openDiffFileContents",
        command: "snapshot review file",
        cwd: config.cwd,
        detail: `Review file exceeds the ${MAX_REVIEW_DIFF_FILE_BYTES}-byte snapshot limit.`,
      });
    }
    while (
      snapshotCache.size > 0 &&
      (snapshotCache.size >= snapshotCacheEntryLimit ||
        snapshotCacheBytes + data.byteLength > snapshotCacheByteLimit)
    ) {
      const oldestId = snapshotCache.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      removeSnapshot(oldestId);
    }
    const snapshotId = NodeCrypto.randomUUID();
    const hash = NodeCrypto.createHash("sha256").update(data).digest("hex");
    snapshotCache.set(snapshotId, { data, expiresAt: now + snapshotCacheTtlMs });
    snapshotCacheBytes += data.byteLength;
    return { snapshotId, totalBytes: data.byteLength, contentHash: hash };
  };

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  const openDiffFileContents: ReviewService["Service"]["openDiffFileContents"] = Effect.fn(
    "ReviewService.openDiffFileContents",
  )(function* (input) {
    const contents = yield* getDiffFileContents(input);
    return yield* Effect.try({
      try: () => {
        const oldFile =
          input.changeType === "new" || input.changeType === "rename-pure"
            ? null
            : cacheSnapshot(contents.oldContents);
        try {
          return {
            oldFile,
            newFile: input.changeType === "deleted" ? null : cacheSnapshot(contents.newContents),
          };
        } catch (cause) {
          if (oldFile !== null) removeSnapshot(oldFile.snapshotId);
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof GitCommandError
          ? cause
          : new GitCommandError({
              operation: "ReviewService.openDiffFileContents",
              command: "snapshot review file",
              cwd: input.cwd,
              detail: "Could not create a review file snapshot.",
              cause,
            }),
    });
  });

  const readDiffFileChunk: ReviewService["Service"]["readDiffFileChunk"] = Effect.fn(
    "ReviewService.readDiffFileChunk",
  )((input) =>
    Effect.try({
      try: () => {
        const now = Date.now();
        pruneExpiredSnapshots(now);
        const snapshot = snapshotCache.get(input.snapshotId);
        if (!snapshot) {
          throw new GitCommandError({
            operation: "ReviewService.readDiffFileChunk",
            command: "read review file snapshot",
            cwd: config.cwd,
            detail: "Review file snapshot expired. Refresh the diff and try again.",
          });
        }
        if (input.offset > snapshot.data.byteLength) {
          throw new GitCommandError({
            operation: "ReviewService.readDiffFileChunk",
            command: "read review file snapshot",
            cwd: config.cwd,
            detail: "Review file chunk offset is outside the snapshot.",
          });
        }
        snapshotCache.delete(input.snapshotId);
        snapshotCache.set(input.snapshotId, {
          data: snapshot.data,
          expiresAt: now + snapshotCacheTtlMs,
        });
        const end = Math.min(snapshot.data.byteLength, input.offset + input.limit);
        const chunk = snapshot.data.subarray(input.offset, end);
        const compressed = NodeZlib.gzipSync(chunk);
        const useCompressed = compressed.byteLength < chunk.byteLength;
        return {
          snapshotId: input.snapshotId,
          offset: input.offset,
          totalBytes: snapshot.data.byteLength,
          encoding: useCompressed ? ("gzip-base64" as const) : ("base64" as const),
          decodedBytes: chunk.byteLength,
          dataBase64: (useCompressed ? compressed : chunk).toString("base64"),
          nextOffset: end < snapshot.data.byteLength ? end : null,
        };
      },
      catch: (cause) =>
        cause instanceof GitCommandError
          ? cause
          : new GitCommandError({
              operation: "ReviewService.readDiffFileChunk",
              command: "read review file snapshot",
              cwd: config.cwd,
              detail: "Could not read the review file snapshot.",
              cause,
            }),
    }),
  );

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
    openDiffFileContents,
    readDiffFileChunk,
  });
});

export const layer = Layer.effect(ReviewService, make);
