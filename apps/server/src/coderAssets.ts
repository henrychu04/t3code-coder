/**
 * Coder: answers upstream's asset (`/api/assets/*`) and attachment upload
 * (`/api/attachments/upload/*`) requests for the gateway. The helper opens no listener, so the
 * gateway forwards each loopback request over `coder.serveAsset` and this runs upstream's routes in
 * process, streaming back the response head and then its body in chunks of at most
 * `CODER_ASSET_BODY_CHUNK_BYTES`. An upload's body arrives over `coder.writeRequestBody`; each
 * write settles once the route has read it, so the gateway sends one chunk at a time.
 */
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  CODER_ASSET_BODY_CHUNK_BYTES,
  CoderRequestBodyError,
  type CoderServeAssetInput,
  type CoderServeAssetPart,
  type CoderWriteRequestBodyInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Readable } from "node:stream";

import type * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import type * as ServerConfig from "./config.ts";
import { layerAssetRoute, layerAttachmentUploadRoute } from "./http.ts";
import type * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import type * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import type * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import type * as DocumentText from "./provider/DocumentText.ts";

const ASSET_REQUEST_ORIGIN = "http://helper.invalid";
/** How long a body may wait for its request, or a finished body's id is remembered. */
const REQUEST_BODY_TTL_MS = 60_000;

interface RequestBody {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** Bodies by id, created by whichever of the request and its first chunk arrives first. */
function makeRequestBodies() {
  const open = new Map<string, RequestBody>();
  const finished = new Map<string, number>();
  const sweep = (now: number) => {
    for (const [id, at] of finished) if (now - at > REQUEST_BODY_TTL_MS) finished.delete(id);
  };
  const get = (id: string): RequestBody | null => {
    sweep(Date.now());
    if (finished.has(id)) return null;
    const existing = open.get(id);
    if (existing) return existing;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const body = { readable, writer: writable.getWriter() };
    open.set(id, body);
    // A chunk whose request never arrives is dropped instead of waiting forever.
    setTimeout(() => {
      if (open.get(id) === body && !body.readable.locked) finish(id);
    }, REQUEST_BODY_TTL_MS).unref();
    return body;
  };
  const finish = (id: string) => {
    const body = open.get(id);
    open.delete(id);
    finished.set(id, Date.now());
    if (body) void body.writer.abort(new Error("The request finished.")).catch(() => undefined);
  };
  return { get, finish };
}

function bodyStream(response: HttpServerResponse.HttpServerResponse): Stream.Stream<Uint8Array> {
  const body = response.body;
  switch (body._tag) {
    case "Empty":
    case "FormData":
      return Stream.empty;
    case "Uint8Array":
      return Stream.make(body.body);
    case "Stream":
      return body.stream.pipe(Stream.orDie);
    case "Raw":
      if (body.body instanceof Readable) {
        const readable = body.body;
        return NodeStream.fromReadable({ evaluate: () => readable }).pipe(Stream.orDie);
      }
      if (body.body instanceof ReadableStream) {
        const readable = body.body as ReadableStream<Uint8Array>;
        return Stream.fromReadableStream({
          evaluate: () => readable,
          onError: (cause) => cause,
        }).pipe(Stream.orDie);
      }
      return Stream.die(new Error("Unsupported asset response body."));
  }
}

function splitChunk(chunk: Uint8Array): ReadonlyArray<Uint8Array> {
  if (chunk.byteLength <= CODER_ASSET_BODY_CHUNK_BYTES) return [chunk];
  const parts: Array<Uint8Array> = [];
  for (let offset = 0; offset < chunk.byteLength; offset += CODER_ASSET_BODY_CHUNK_BYTES) {
    parts.push(chunk.subarray(offset, offset + CODER_ASSET_BODY_CHUNK_BYTES));
  }
  return parts;
}

export const makeServeAsset = Effect.gen(function* () {
  const assetRoute = yield* HttpRouter.toHttpEffect(
    Layer.mergeAll(layerAssetRoute, layerAttachmentUploadRoute),
  );
  const bodies = makeRequestBodies();
  const services = yield* Effect.context<
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | Orchestrator.OrchestratorV2
    | ServerConfig.ServerConfig
    | ServerSecretStore.ServerSecretStore
    | ProjectFaviconResolver.ProjectFaviconResolver
    | WorkspacePaths.WorkspacePaths
    | DocumentText.DocumentText
  >();
  const platform = yield* Layer.build(NodeHttpPlatform.layer);
  const serve = (input: CoderServeAssetInput): Stream.Stream<CoderServeAssetPart> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const headers = new Headers();
        if (input.range !== undefined) headers.set("range", input.range);
        if (input.ifRange !== undefined) headers.set("if-range", input.ifRange);
        if (input.contentType !== undefined) headers.set("content-type", input.contentType);
        if (input.contentLength !== undefined) {
          headers.set("content-length", String(input.contentLength));
        }
        const bodyId = input.method === "POST" ? input.bodyId : undefined;
        const body = bodyId === undefined ? null : bodies.get(bodyId);
        if (bodyId !== undefined)
          yield* Effect.addFinalizer(() => Effect.sync(() => bodies.finish(bodyId)));
        const request = HttpServerRequest.fromWeb(
          new Request(new URL(input.path, ASSET_REQUEST_ORIGIN), {
            method: input.method,
            headers,
            ...(body === null ? {} : { body: body.readable, duplex: "half" }),
          } as RequestInit),
        );
        const response = yield* assetRoute.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideContext(Context.merge(services, platform)),
          // As upstream's HTTP server answers a failed request (404 for an unknown route).
          Effect.catchCause((cause) =>
            Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
          ),
        );
        const head: CoderServeAssetPart = {
          _tag: "head",
          status: response.status,
          headers: { ...response.headers },
        };
        const responseBody =
          input.method === "HEAD"
            ? Stream.empty
            : bodyStream(response).pipe(
                Stream.flatMap((chunk) => Stream.fromIterable(splitChunk(chunk))),
                Stream.map((chunk): CoderServeAssetPart => ({
                  _tag: "body",
                  dataBase64: Buffer.from(
                    chunk.buffer,
                    chunk.byteOffset,
                    chunk.byteLength,
                  ).toString("base64"),
                })),
              );
        // One part per RPC chunk, so each acked message stays within the gateway's frame limit.
        return Stream.concat(Stream.make(head), responseBody).pipe(Stream.rechunk(1));
      }),
    );
  const writeRequestBody = (input: CoderWriteRequestBodyInput) =>
    Effect.tryPromise({
      try: async () => {
        const body = bodies.get(input.bodyId);
        if (body === null) throw new Error("The request already finished.");
        if (input.dataBase64.length > 0) {
          await body.writer.write(new Uint8Array(Buffer.from(input.dataBase64, "base64")));
        }
        if (input.done) await body.writer.close();
      },
      catch: (cause) =>
        new CoderRequestBodyError({
          message: cause instanceof Error ? cause.message : "The request body was not accepted.",
        }),
    });
  return { serve, writeRequestBody };
});
