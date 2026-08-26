import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  sourceKind: Schema.optionalKey(ReviewDiffPreviewSourceKind),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const MAX_REVIEW_DIFF_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_REVIEW_DIFF_FILE_CHUNK_BYTES = 512 * 1024;

export const ReviewDiffFileSnapshotReference = Schema.Struct({
  snapshotId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  totalBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_REVIEW_DIFF_FILE_BYTES)),
  contentHash: TrimmedNonEmptyString,
});
export type ReviewDiffFileSnapshotReference = typeof ReviewDiffFileSnapshotReference.Type;

export const ReviewDiffFileSnapshotResult = Schema.Struct({
  oldFile: Schema.NullOr(ReviewDiffFileSnapshotReference),
  newFile: Schema.NullOr(ReviewDiffFileSnapshotReference),
});
export type ReviewDiffFileSnapshotResult = typeof ReviewDiffFileSnapshotResult.Type;

export const ReviewDiffFileChunkInput = Schema.Struct({
  snapshotId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_REVIEW_DIFF_FILE_CHUNK_BYTES)),
});
export type ReviewDiffFileChunkInput = typeof ReviewDiffFileChunkInput.Type;

export const ReviewDiffFileChunkResult = Schema.Struct({
  snapshotId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  offset: NonNegativeInt,
  totalBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_REVIEW_DIFF_FILE_BYTES)),
  dataBase64: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type ReviewDiffFileChunkResult = typeof ReviewDiffFileChunkResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
