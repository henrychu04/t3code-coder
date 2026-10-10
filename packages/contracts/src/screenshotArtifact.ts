import * as Schema from "effect/Schema";

import {
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "./chatAttachment.ts";
import { ProjectFilesOwnerFields } from "./project.ts";

export const MAX_SCREENSHOT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES = 512 * 1024;
/** Workspace video and audio are read whole into browser memory, so they keep a larger explicit bound. */
export const MAX_PROJECT_MEDIA_BYTES = 256 * 1024 * 1024;

// Attachment reads share this id; upstream's thread-scoped attachment ids run up to 128 characters.
export const ScreenshotArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
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

/** Screenshots a pre-v2 conversation saved on tool activities after one imported message. */
export const MAX_LEGACY_SCREENSHOT_ARTIFACTS_PER_MESSAGE = 100;
export const LegacyScreenshotArtifactsInput = Schema.Struct({ messageId: MessageId });
export type LegacyScreenshotArtifactsInput = typeof LegacyScreenshotArtifactsInput.Type;

export const LegacyScreenshotArtifactsResult = Schema.Struct({
  artifacts: Schema.Array(ScreenshotArtifactReference).check(
    Schema.isMaxLength(MAX_LEGACY_SCREENSHOT_ARTIFACTS_PER_MESSAGE),
  ),
});
export type LegacyScreenshotArtifactsResult = typeof LegacyScreenshotArtifactsResult.Type;

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

/** Browser-renderable images, videos, and audio an on-demand workspace media read may return. */
export const ProjectMediaMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/svg+xml",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "video/x-matroska",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/aiff",
]);
export type ProjectMediaMimeType = typeof ProjectMediaMimeType.Type;

/** On-demand image paths resolve on the environment machine, relative to the verified owner root. */
export const ProjectImageReadInput = Schema.Struct({
  ...ProjectFilesOwnerFields,
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES)),
  revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type ProjectImageReadInput = typeof ProjectImageReadInput.Type;
export const ProjectImageChunk = Schema.Struct({
  dimensions: Schema.optional(ScreenshotArtifactDimensions),
  mimeType: ProjectMediaMimeType,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_PROJECT_MEDIA_BYTES)),
  dataBase64: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
  revision: Schema.String,
});
export type ProjectImageChunk = typeof ProjectImageChunk.Type;
export class ProjectImageReadError extends Schema.TaggedError<ProjectImageReadError>()(
  "ProjectImageReadError",
  { message: TrimmedNonEmptyString },
) {}

/**
 * Bytes a stored turn item names: its captured MCP App document, or an image its tool returned
 * inline, by order in the output. Upstream serves both through signed asset URLs; the helper
 * serves them as bounded stdio chunks instead.
 */
export const TurnItemAsset = Schema.Union([
  Schema.TaggedStruct("mcp-app-document", {}),
  Schema.TaggedStruct("tool-output-image", { index: NonNegativeInt }),
]);
export type TurnItemAsset = typeof TurnItemAsset.Type;

/** The larger of an MCP App document (5 MiB) and a tool output image (a provider turn's image limit). */
export const MAX_TURN_ITEM_ASSET_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

export const TurnItemAssetMimeType = Schema.Literals([
  "text/html",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export type TurnItemAssetMimeType = typeof TurnItemAssetMimeType.Type;

export const TurnItemAssetReadInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
  asset: TurnItemAsset,
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES)),
});
export type TurnItemAssetReadInput = typeof TurnItemAssetReadInput.Type;

export const TurnItemAssetChunk = Schema.Struct({
  mimeType: TurnItemAssetMimeType,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TURN_ITEM_ASSET_BYTES)),
  dataBase64: Schema.String,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type TurnItemAssetChunk = typeof TurnItemAssetChunk.Type;

export class TurnItemAssetReadError extends Schema.TaggedError<TurnItemAssetReadError>()(
  "TurnItemAssetReadError",
  { message: TrimmedNonEmptyString },
) {}
