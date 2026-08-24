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

export const ScreenshotArtifactReference = Schema.Struct({
  id: ScreenshotArtifactId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  mimeType: ScreenshotArtifactMimeType,
  sizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_BYTES)),
});
export type ScreenshotArtifactReference = typeof ScreenshotArtifactReference.Type;

export const ScreenshotArtifactReadInput = Schema.Struct({
  artifactId: ScreenshotArtifactId,
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

export class ScreenshotArtifactReadError extends Schema.TaggedErrorClass<ScreenshotArtifactReadError>()(
  "ScreenshotArtifactReadError",
  {
    artifactId: ScreenshotArtifactId,
    message: TrimmedNonEmptyString,
  },
) {}
