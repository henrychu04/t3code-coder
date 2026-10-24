import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";

const requireGateway = createRequire(
  new URL("../apps/coder-gateway/package.json", import.meta.url),
);
const { WebSocket } = requireGateway("ws");
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwCqpf1ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13PLIEAOXyUUwAAAABJRU5ErkJggg==",
  "base64",
);

export function workspaceEndpoint(url, workspaceId) {
  return `${url}/api/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Opens a connected workspace's RPC socket; `rpc` resolves with a request's success value. */
export async function connectRpc(url, workspaceId) {
  const endpoint = workspaceEndpoint(url, workspaceId);
  const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/rpc`, { origin: url });
  await once(socket, "open", { signal: AbortSignal.timeout(30_000) });
  let nextId = 0;
  const rpc = (tag, payload, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const requestId = String(++nextId);
      const finish = (error, value) => {
        clearTimeout(timeout);
        socket.off("message", receive);
        socket.off("close", closed);
        if (error) reject(error);
        else resolve(value);
      };
      const closed = () => finish(new Error(`${tag}: RPC connection closed`));
      const receive = (data) => {
        const message = JSON.parse(data.toString());
        if (message._tag !== "Exit" || message.requestId !== requestId) return;
        if (message.exit._tag !== "Success") {
          return finish(new Error(`${tag} failed: ${JSON.stringify(message.exit.cause)}`));
        }
        finish(undefined, message.exit.value);
      };
      const timeout = setTimeout(() => finish(new Error(`${tag} timed out`)), timeoutMs);
      socket.on("message", receive);
      socket.on("close", closed);
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
  const close = async () => {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  };
  return { endpoint, rpc, close };
}

/**
 * Uploads `bytes` through upstream's signed upload URL, as the composer does, and returns the
 * turn attachment that names it.
 */
export async function uploadImage(url, endpoint, rpc, bytes = png) {
  const name = "fixture.png";
  const mimeType = "image/png";
  const { attachmentId, relativeUrl } = await rpc("attachments.createUploadUrl", {
    type: "image",
    name,
    mimeType,
    sizeBytes: bytes.length,
  });
  const response = await fetch(`${endpoint}${relativeUrl}`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": mimeType },
    body: bytes,
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(response.status, 204, `Image upload failed: ${await response.text()}`);
  return { type: "image", id: attachmentId, name, mimeType, sizeBytes: bytes.length };
}

/** Mints a signed asset URL for `resource` and reads it through the gateway. */
export async function readAsset(endpoint, rpc, resource) {
  const { relativeUrl } = await rpc("assets.createUrl", { resource });
  const response = await fetch(`${endpoint}${relativeUrl}`, {
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(response.status, 200, `Asset read failed: ${await response.clone().text()}`);
  return { relativeUrl, response, bytes: Buffer.from(await response.arrayBuffer()) };
}

// Uses the production gateway, upstream's signed upload and asset URLs, and the helper. No
// provider or authentication mocks. This verifies transport/persistence, not a model's decision
// to view or return an image.
export async function testLiveImages(url, workspaceId) {
  const endpoint = workspaceEndpoint(url, workspaceId);
  const connection = async (method) => {
    const response = await fetch(`${endpoint}/connection`, {
      method,
      headers: { Origin: url },
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(response.status, 200, `connection ${method} failed: ${await response.text()}`);
  };
  await connection("POST");
  let session = await connectRpc(url, workspaceId);
  const attachment = await uploadImage(url, endpoint, session.rpc);
  const resource = { _tag: "attachment", attachmentId: attachment.id, mimeType: "image/png" };

  const read = async () => {
    const { relativeUrl, response, bytes } = await readAsset(endpoint, session.rpc, resource);
    assert.deepEqual(bytes, png, "Attachment bytes must match the upload");
    assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
    // The token follows `/api/assets/`; its first character carries signed payload bits.
    const at = "/api/assets/".length;
    const flipped = relativeUrl[at] === "A" ? "B" : "A";
    const tampered = `${relativeUrl.slice(0, at)}${flipped}${relativeUrl.slice(at + 1)}`;
    const rejected = await fetch(`${endpoint}${tampered}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(rejected.status, 404, "A tampered asset URL must be rejected");
  };
  await read();

  const { relativeUrl } = await session.rpc("attachments.createUploadUrl", {
    type: "image",
    name: "fixture.png",
    mimeType: "image/png",
    sizeBytes: png.length,
  });
  const withoutOrigin = await fetch(`${endpoint}${relativeUrl}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(withoutOrigin.status, 403, "An upload without the gateway Origin must be refused");

  await session.close();
  await connection("DELETE");
  const disconnected = await fetch(`${endpoint}/api/assets/unused`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(disconnected.status, 503, "A disconnected workspace must not serve assets");
  await connection("POST");
  session = await connectRpc(url, workspaceId);
  try {
    await read();
  } finally {
    await session.close();
  }
  console.log(
    "PASS: real Coder image upload, signed asset reads, URL and Origin rejection, and helper reconnect persistence.",
  );
}
