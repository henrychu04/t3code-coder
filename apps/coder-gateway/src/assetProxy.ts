import type * as NodeHttp from "node:http";

import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import { type CoderServeAssetInput, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Matches the pathname `/api/workspaces/<id>/api/assets/...` of a workspace's asset URL. As upstream's
 * route reads only the pathname, a query string is not forwarded.
 */
export const WORKSPACE_ASSET_ROUTE = /^\/api\/workspaces\/([^/]+)(\/api\/assets\/.*)$/;

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

let nextAssetRequestId = 0;

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

/**
 * Coder: answers one `GET`/`HEAD` asset request through the workspace helper's `coder.serveAsset`
 * stream, which runs upstream's asset route in the workspace. Only `Range` and `If-Range` are
 * forwarded. Each body chunk is acknowledged once the socket accepts it, so a slow browser holds
 * back the helper rather than gateway memory, and a closed request interrupts the helper's read.
 */
export function proxyWorkspaceAsset(
  helper: CoderHelperConnection,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  assetPath: string,
): Promise<void> {
  const requestId = `gateway-asset:${String(nextAssetRequestId++)}`;
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const range = method === "GET" ? singleHeader(request.headers.range) : undefined;
  const ifRange = singleHeader(request.headers["if-range"]);
  const payload: CoderServeAssetInput = {
    method,
    path: assetPath,
    ...(range === undefined ? {} : { range }),
    ...(ifRange === undefined ? {} : { ifRange }),
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
  });
}
