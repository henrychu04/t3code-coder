/**
 * Coder: answers upstream's `/api/assets/*` requests for the gateway. The helper opens no
 * listener, so the gateway forwards each loopback asset request over `coder.serveAsset` and this
 * runs upstream's asset route in process, streaming back the response head and then its body in
 * chunks of at most `CODER_ASSET_BODY_CHUNK_BYTES`.
 */
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  CODER_ASSET_BODY_CHUNK_BYTES,
  type CoderServeAssetInput,
  type CoderServeAssetPart,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { HttpRouter, HttpServerError, HttpServerRequest, type HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Readable } from "node:stream";

import type * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import type * as ServerConfig from "./config.ts";
import { layerAssetRoute } from "./http.ts";
import type * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import type * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const ASSET_REQUEST_ORIGIN = "http://helper.invalid";

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
        return Stream.fromReadableStream({ evaluate: () => readable, onError: (cause) => cause }).pipe(
          Stream.orDie,
        );
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
  const assetRoute = yield* HttpRouter.toHttpEffect(layerAssetRoute);
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Orchestrator.OrchestratorV2
    | ServerConfig.ServerConfig
    | ServerSecretStore.ServerSecretStore
    | WorkspacePaths.WorkspacePaths
  >();
  const platform = yield* Layer.build(NodeHttpPlatform.layer);
  return (input: CoderServeAssetInput): Stream.Stream<CoderServeAssetPart> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const headers = new Headers();
        if (input.range !== undefined) headers.set("range", input.range);
        if (input.ifRange !== undefined) headers.set("if-range", input.ifRange);
        const request = HttpServerRequest.fromWeb(
          new Request(new URL(input.path, ASSET_REQUEST_ORIGIN), {
            method: input.method,
            headers,
          }),
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
        const body =
          input.method === "HEAD"
            ? Stream.empty
            : bodyStream(response).pipe(
                Stream.flatMap((chunk) => Stream.fromIterable(splitChunk(chunk))),
                Stream.map(
                  (chunk): CoderServeAssetPart => ({
                    _tag: "body",
                    dataBase64: Buffer.from(
                      chunk.buffer,
                      chunk.byteOffset,
                      chunk.byteLength,
                    ).toString("base64"),
                  }),
                ),
              );
        // One part per RPC chunk, so each acked message stays within the gateway's frame limit.
        return Stream.concat(Stream.make(head), body).pipe(Stream.rechunk(1));
      }),
    );
});
