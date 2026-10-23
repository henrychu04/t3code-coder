import * as Schema from "effect/Schema";

/**
 * Coder: one asset response body chunk from the helper. 1 MiB of bytes is about 1.4 MiB of
 * base64, well under the gateway's RPC frame limit.
 */
export const CODER_ASSET_BODY_CHUNK_BYTES = 1024 * 1024;

/** Coder: an upstream `/api/assets/*` request the gateway forwards to the helper. */
export const CoderServeAssetInput = Schema.Struct({
  method: Schema.Literals(["GET", "HEAD"]),
  /** The request path and query, starting with upstream's `/api/assets/`. */
  path: Schema.String.check(Schema.isMaxLength(8192)),
  range: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  ifRange: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type CoderServeAssetInput = typeof CoderServeAssetInput.Type;

export const CoderServeAssetPart = Schema.Union([
  Schema.TaggedStruct("head", {
    status: Schema.Int,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.TaggedStruct("body", {
    dataBase64: Schema.String,
  }),
]);
export type CoderServeAssetPart = typeof CoderServeAssetPart.Type;
