import * as Schema from "effect/Schema";

/**
 * Coder: one asset response or upload request body chunk between the gateway and the helper.
 * 1 MiB of bytes is about 1.4 MiB of base64, well under the gateway's RPC frame limit.
 */
export const CODER_ASSET_BODY_CHUNK_BYTES = 1024 * 1024;

/**
 * Coder: an upstream asset (`/api/assets/*`, `GET`/`HEAD`) or attachment upload
 * (`/api/attachments/upload/*`, `POST`) request the gateway forwards to the helper. An upload's
 * body follows over `coder.writeRequestBody` under `bodyId`.
 */
export const CoderServeAssetInput = Schema.Struct({
  method: Schema.Literals(["GET", "HEAD", "POST"]),
  /** The request path, starting with upstream's `/api/assets/` or `/api/attachments/upload/`. */
  path: Schema.String.check(Schema.isMaxLength(8192)),
  range: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  ifRange: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  contentType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  contentLength: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bodyId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
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

/** Coder: the next chunk of a forwarded request's body; `done` ends it. */
export const CoderWriteRequestBodyInput = Schema.Struct({
  bodyId: Schema.String.check(Schema.isMaxLength(128)),
  dataBase64: Schema.String,
  done: Schema.Boolean,
});
export type CoderWriteRequestBodyInput = typeof CoderWriteRequestBodyInput.Type;

export class CoderRequestBodyError extends Schema.TaggedError<CoderRequestBodyError>()(
  "CoderRequestBodyError",
  { message: Schema.String },
) {}
