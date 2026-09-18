import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_SCREENSHOT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES = 512 * 1024;

export const ScreenshotArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("ScreenshotArtifactId"),
);
export type ScreenshotArtifactId = typeof ScreenshotArtifactId.Type;

export const ScreenshotArtifactMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export type ScreenshotArtifactMimeType = typeof ScreenshotArtifactMimeType.Type;

export const ScreenshotArtifactDimensions = Schema.Struct({
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(0xffff_ffff)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(0xffff_ffff)),
});
export type ScreenshotArtifactDimensions = typeof ScreenshotArtifactDimensions.Type;

export const ScreenshotArtifactReference = Schema.Struct({
  id: ScreenshotArtifactId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  mimeType: ScreenshotArtifactMimeType,
  dimensions: Schema.optional(ScreenshotArtifactDimensions),
  /** Legacy capture metadata. New image previews do not use path associations. */
  sourcePathKeys: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
      Schema.isMaxLength(100),
    ),
  ),
  sizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_BYTES)),
});
export type ScreenshotArtifactReference = typeof ScreenshotArtifactReference.Type;

export const ScreenshotArtifactReadInput = Schema.Struct({
  artifactId: ScreenshotArtifactId,
  source: Schema.optional(Schema.Literals(["artifact", "attachment"])),
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES)),
});
export type ScreenshotArtifactReadInput = typeof ScreenshotArtifactReadInput.Type;

export const ScreenshotArtifactChunk = Schema.Struct({
  artifactId: ScreenshotArtifactId,
  mimeType: ScreenshotArtifactMimeType,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_BYTES)),
  dataBase64: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type ScreenshotArtifactChunk = typeof ScreenshotArtifactChunk.Type;

export class ScreenshotArtifactReadError extends Schema.TaggedError<ScreenshotArtifactReadError>()(
  "ScreenshotArtifactReadError",
  {
    artifactId: ScreenshotArtifactId,
    message: TrimmedNonEmptyString,
  },
) {}

/** On-demand image reads use the thread's project, never capture associations. */
export const ProjectImageReadInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES)),
  revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type ProjectImageReadInput = typeof ProjectImageReadInput.Type;
export const ProjectImageChunk = Schema.Struct({
  dimensions: Schema.optional(ScreenshotArtifactDimensions),
  mimeType: ScreenshotArtifactMimeType,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_BYTES)),
  dataBase64: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
  revision: Schema.String,
});
export type ProjectImageChunk = typeof ProjectImageChunk.Type;
export class ProjectImageReadError extends Schema.TaggedError<ProjectImageReadError>()(
  "ProjectImageReadError",
  { message: TrimmedNonEmptyString },
) {}
