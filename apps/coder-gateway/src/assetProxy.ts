import type * as NodeHttp from "node:http";

import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import {
  CODER_ASSET_BODY_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type CoderServeAssetInput,
  type CoderWriteRequestBodyInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Matches the pathname `/api/workspaces/<id>/api/assets/...` of a workspace's asset URL. As upstream's
 * route reads only the pathname, a query string is not forwarded.
 */
export const WORKSPACE_ASSET_ROUTE = /^\/api\/workspaces\/([^/]+)(\/api\/assets\/.*)$/;

/** Matches `/api/workspaces/<id>/api/attachments/upload/<token>`, upstream's signed upload URL. */
export const WORKSPACE_UPLOAD_ROUTE =
  /^\/api\/workspaces\/([^/]+)(\/api\/attachments\/upload\/[^/]+)$/;

// Response headers upstream's asset route sets; anything else from the workspace is dropped.
const FORWARDED_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-security-policy",
  "content-type",
  "etag",
  "last-modified",
]);

/** The largest upload upstream mints a URL for (a composer file); images are smaller. */
export const MAX_FORWARDED_UPLOAD_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

let nextAssetRequestId = 0;
let nextBodyId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length <= 256 ? value : undefined;
}

function responseHeaders(headers: unknown): Record<string, string> {
  const forwarded: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  };
  if (!isRecord(headers)) return forwarded;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (typeof value === "string" && FORWARDED_RESPONSE_HEADERS.has(key)) forwarded[key] = value;
  }
  return forwarded;
}

/** Sends one request to the helper and settles with its exit. */
function callHelper(
  helper: CoderHelperConnection,
  tag: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const id = `gateway-call:${String(nextAssetRequestId++)}`;
  return new Promise((resolve, reject) => {
    const unsubscribe = helper.onRpcMessage((message) => {
      if (!isRecord(message) || message.requestId !== id || message._tag !== "Exit") return;
      unsubscribe();
      resolve(isRecord(message.exit) ? message.exit : {});
    });
    void Effect.runPromiseExit(
      helper.sendRpc({ _tag: "Request", id, tag, payload, headers: [] }),
    ).then((exit) => {
      if (exit._tag === "Failure") {
        unsubscribe();
        reject(new Error("The workspace helper is disconnected."));
      }
    });
  });
}

/**
 * Coder: answers one asset (`GET`/`HEAD`) or attachment upload (`POST`) request through the
 * workspace helper's `coder.serveAsset` stream, which runs upstream's routes in the workspace.
 * Only `Range`, `If-Range`, and an upload's `Content-Type` and `Content-Length` are forwarded. Each
 * response chunk is acknowledged once the socket accepts it, so a slow browser holds back the
 * helper rather than gateway memory, and a closed request interrupts the helper's work. An upload's
 * body goes to the helper in chunks of `CODER_ASSET_BODY_CHUNK_BYTES`, each sent once the route
 * has read the previous one.
 */
export function proxyWorkspaceAsset(
  helper: CoderHelperConnection,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  assetPath: string,
  upload?: { readonly contentLength: number },
): Promise<void> {
  const requestId = `gateway-asset:${String(nextAssetRequestId++)}`;
  const method = upload ? "POST" : request.method === "HEAD" ? "HEAD" : "GET";
  const range = method === "GET" ? singleHeader(request.headers.range) : undefined;
  const ifRange = method === "POST" ? undefined : singleHeader(request.headers["if-range"]);
  const contentType = upload ? singleHeader(request.headers["content-type"]) : undefined;
  const bodyId = upload ? `gateway-body:${String(nextBodyId++)}` : undefined;
  const payload: CoderServeAssetInput = {
    method,
    path: assetPath,
    ...(range === undefined ? {} : { range }),
    ...(ifRange === undefined ? {} : { ifRange }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(upload && bodyId !== undefined ? { contentLength: upload.contentLength, bodyId } : {}),
  };

  return new Promise<void>((resolve) => {
    let finished = false;
    let pending: Promise<void> = Promise.resolve();

    const fail = () => {
      if (finished) return;
      if (!response.headersSent) {
        response.writeHead(502, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end("Workspace asset unavailable.");
      } else {
        response.destroy();
      }
      finish();
    };
    const sendRpc = (message: unknown) => {
      void Effect.runPromiseExit(helper.sendRpc(message)).then((exit) => {
        if (exit._tag === "Failure") fail();
      });
    };
    const onClose = () => {
      if (finished) return;
      sendRpc({ _tag: "Interrupt", requestId });
      finish();
    };
    const unsubscribe = helper.onRpcMessage((message) => {
      if (!isRecord(message) || message.requestId !== requestId) return;
      pending = pending.then(() => receive(message));
    });
    // A helper that exits mid-response never sends this request's exit.
    const helperExit = Effect.runFork(helper.closed);
    helperExit.addObserver(() => fail());

    function finish() {
      if (finished) return;
      finished = true;
      unsubscribe();
      response.off("close", onClose);
      Effect.runFork(Fiber.interrupt(helperExit));
      resolve();
    }

    async function receive(message: Record<string, unknown>): Promise<void> {
      if (finished) return;
      if (message._tag === "Exit") {
        const exit = message.exit;
        if (isRecord(exit) && exit._tag === "Success" && response.headersSent) {
          response.end();
          finish();
        } else {
          fail();
        }
        return;
      }
      if (message._tag !== "Chunk" || !Array.isArray(message.values)) return;
      for (const value of message.values) {
        if (!isRecord(value)) continue;
        if (value._tag === "head" && !response.headersSent) {
          response.writeHead(
            typeof value.status === "number" ? value.status : 502,
            responseHeaders(value.headers),
          );
          response.flushHeaders();
        } else if (value._tag === "body" && typeof value.dataBase64 === "string") {
          if (!response.headersSent) return fail();
          if (!response.write(Buffer.from(value.dataBase64, "base64"))) {
            await new Promise<void>((drained) => {
              const done = () => {
                response.off("drain", done);
                response.off("close", done);
                drained();
              };
              response.once("drain", done);
              response.once("close", done);
            });
          }
        }
      }
      if (!finished) sendRpc({ _tag: "Ack", requestId });
    }

    response.on("close", onClose);
    sendRpc({
      _tag: "Request",
      id: requestId,
      tag: WS_METHODS.coderServeAsset,
      payload,
      headers: [],
    });
    if (upload && bodyId !== undefined) {
      void pumpRequestBody(helper, request, bodyId, upload.contentLength, () => finished).catch(
        () => {
          if (finished) return;
          request.resume();
          sendRpc({ _tag: "Interrupt", requestId });
          fail();
        },
      );
    }
  });
}

/** Streams an upload's body to the helper, one acknowledged chunk at a time. */
async function pumpRequestBody(
  helper: CoderHelperConnection,
  request: NodeHttp.IncomingMessage,
  bodyId: string,
  contentLength: number,
  stopped: () => boolean,
): Promise<void> {
  const write = async (data: Buffer, done: boolean) => {
    const input: CoderWriteRequestBodyInput = {
      bodyId,
      dataBase64: data.toString("base64"),
      done,
    };
    const exit = await callHelper(helper, WS_METHODS.coderWriteRequestBody, input);
    if (exit._tag !== "Success") throw new Error("The workspace refused the upload body.");
  };
  let pending: Buffer = Buffer.alloc(0);
  let received = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    if (stopped()) return;
    received += chunk.byteLength;
    if (received > contentLength) throw new Error("The upload is larger than declared.");
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.byteLength >= CODER_ASSET_BODY_CHUNK_BYTES) {
      const next = pending.subarray(0, CODER_ASSET_BODY_CHUNK_BYTES);
      pending = pending.subarray(CODER_ASSET_BODY_CHUNK_BYTES);
      await write(next, false);
      if (stopped()) return;
    }
  }
  if (stopped()) return;
  if (received !== contentLength) throw new Error("The upload is smaller than declared.");
  await write(pending, true);
}
