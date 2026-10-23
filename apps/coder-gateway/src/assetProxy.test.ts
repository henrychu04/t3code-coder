import assert from "node:assert/strict";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import { CODER_ASSET_BODY_CHUNK_BYTES, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  proxyWorkspaceAsset,
  WORKSPACE_ASSET_ROUTE,
  WORKSPACE_UPLOAD_ROUTE,
} from "./assetProxy.ts";

interface FakeHelper {
  readonly connection: CoderHelperConnection;
  readonly sent: Array<Record<string, unknown>>;
  readonly emit: (message: unknown) => void;
}

function fakeHelper(): FakeHelper {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Set<(message: unknown) => void>();
  return {
    connection: {
      info: {} as never,
      closed: Effect.never,
      sendRpc: (message) => Effect.sync(() => void sent.push(message as Record<string, unknown>)),
      needsDrain: () => false,
      drained: Effect.void,
      onRpcMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: Effect.void,
    },
    sent,
    emit: (message) => {
      for (const listener of listeners) listener(message);
    },
  };
}

async function eventually<A>(read: () => A | undefined, timeoutMs = 1000): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withServer(
  helper: FakeHelper,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = NodeHttp.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const upload = request.method === "POST" ? pathname.match(WORKSPACE_UPLOAD_ROUTE) : null;
    const route = upload ?? pathname.match(WORKSPACE_ASSET_ROUTE);
    void proxyWorkspaceAsset(
      helper.connection,
      request,
      response,
      route?.[2] ?? "",
      upload ? { contentLength: Number(request.headers["content-length"]) } : undefined,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const request = (helper: FakeHelper, index = 0) =>
  eventually(() => helper.sent.filter((message) => message._tag === "Request")[index]);

const acks = (helper: FakeHelper, requestId: unknown) =>
  helper.sent.filter((message) => message._tag === "Ack" && message.requestId === requestId);

test("streams the helper's asset response, acknowledging each chunk", async () => {
  const helper = fakeHelper();
  await withServer(helper, async (origin) => {
    const pendingResponse = fetch(`${origin}/api/workspaces/ws-1/api/assets/token/shot.png?v=1`, {
      headers: { range: "bytes=0-3", cookie: "ignored=1" },
    });
    const sent = await request(helper);
    assert.equal(sent.tag, WS_METHODS.coderServeAsset);
    assert.deepEqual(sent.payload, {
      method: "GET",
      path: "/api/assets/token/shot.png",
      range: "bytes=0-3",
    });
    helper.emit({
      _tag: "Chunk",
      requestId: sent.id,
      values: [
        {
          _tag: "head",
          status: 206,
          headers: {
            "content-type": "image/png",
            "cache-control": "private, max-age=3600",
            "set-cookie": "session=leaked",
            "x-frame-options": "DENY",
          },
        },
      ],
    });
    await eventually(() => (acks(helper, sent.id).length === 1 ? true : undefined));
    helper.emit({
      _tag: "Chunk",
      requestId: sent.id,
      values: [{ _tag: "body", dataBase64: Buffer.from("png!").toString("base64") }],
    });
    await eventually(() => (acks(helper, sent.id).length === 2 ? true : undefined));
    helper.emit({ _tag: "Exit", requestId: sent.id, exit: { _tag: "Success", value: undefined } });

    const response = await pendingResponse;
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.equal(await response.text(), "png!");
  });
});

test("answers 502 when the helper fails before the head", async () => {
  const helper = fakeHelper();
  await withServer(helper, async (origin) => {
    const pendingResponse = fetch(`${origin}/api/workspaces/ws-1/api/assets/token/shot.png`);
    const sent = await request(helper);
    helper.emit({ _tag: "Exit", requestId: sent.id, exit: { _tag: "Failure", cause: [] } });
    const response = await pendingResponse;
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("interrupts the helper's stream when the browser goes away", async () => {
  const helper = fakeHelper();
  await withServer(helper, async (origin) => {
    const controller = new AbortController();
    const pendingResponse = fetch(`${origin}/api/workspaces/ws-1/api/assets/token/clip.mp4`, {
      signal: controller.signal,
    });
    const sent = await request(helper);
    helper.emit({
      _tag: "Chunk",
      requestId: sent.id,
      values: [{ _tag: "head", status: 200, headers: { "content-type": "video/mp4" } }],
    });
    await pendingResponse;
    controller.abort();
    await eventually(() =>
      helper.sent.find((message) => message._tag === "Interrupt" && message.requestId === sent.id),
    );
  });
});

test("streams an upload body to the helper in acknowledged chunks", async () => {
  const helper = fakeHelper();
  const body = Buffer.alloc(CODER_ASSET_BODY_CHUNK_BYTES + 3, 9);
  await withServer(helper, async (origin) => {
    const pendingResponse = fetch(`${origin}/api/workspaces/ws-1/api/attachments/upload/token`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    const serve = await request(helper);
    assert.equal(serve.tag, WS_METHODS.coderServeAsset);
    assert.deepEqual(serve.payload, {
      method: "POST",
      path: "/api/attachments/upload/token",
      contentType: "application/octet-stream",
      contentLength: body.byteLength,
      bodyId: (serve.payload as { bodyId: string }).bodyId,
    });
    const received: Array<Buffer> = [];
    for (let index = 1; ; index++) {
      const write = await request(helper, index);
      assert.equal(write.tag, WS_METHODS.coderWriteRequestBody);
      const payload = write.payload as { dataBase64: string; done: boolean };
      received.push(Buffer.from(payload.dataBase64, "base64"));
      helper.emit({
        _tag: "Exit",
        requestId: write.id,
        exit: { _tag: "Success", value: undefined },
      });
      if (payload.done) break;
    }
    assert.ok(received.every((chunk) => chunk.byteLength <= CODER_ASSET_BODY_CHUNK_BYTES));
    assert.ok(Buffer.concat(received).equals(body));
    helper.emit({
      _tag: "Chunk",
      requestId: serve.id,
      values: [{ _tag: "head", status: 204, headers: {} }],
    });
    helper.emit({ _tag: "Exit", requestId: serve.id, exit: { _tag: "Success", value: undefined } });
    assert.equal((await pendingResponse).status, 204);
  });
});
