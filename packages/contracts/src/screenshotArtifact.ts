import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_SCREENSHOT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_ARTIFACTS_PER_TURN = 10;
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
  /** Opaque, artifact-salted fingerprints of contained source paths; never read capabilities. */
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
