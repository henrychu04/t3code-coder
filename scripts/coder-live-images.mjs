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

// Uses the production gateway, SCP upload, and helper RPC. No provider or authentication mocks.
// This verifies transport/persistence, not a model's decision to view or return an image.
export async function testLiveImages(url, workspaceId) {
  const endpoint = `${url}/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const request = async (path, method, body, contentType) => {
    const response = await fetch(`${endpoint}/${path}`, {
      method,
      headers: { Origin: url, ...(contentType ? { "Content-Type": contentType } : {}) },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    if (response.status !== 200) {
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    }
    return response;
  };
  await request("connection", "POST");
  const uploaded = await (await request("clipboard-image", "POST", png, "image/png")).json();
  const match = /\/([0-9a-f-]{36})\.png$/.exec(uploaded.path);
  assert.ok(match, "Upload must return a generated image reference");
  const artifactId = match[1];

  const read = async () => {
    const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/rpc`, { origin: url });
    await once(socket, "open", { signal: AbortSignal.timeout(30_000) });
    let id = 0;
    const rpc = (payload) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        const finish = (error, value) => {
          clearTimeout(timeout);
          socket.off("message", onMessage);
          socket.off("close", onClose);
          if (error) reject(error);
          else resolve(value);
        };
        const onClose = () => finish(new Error("Image RPC connection closed"));
        const onMessage = (data) => {
          const message = JSON.parse(data.toString());
          if (message._tag !== "Exit" || message.requestId !== requestId) return;
          finish(undefined, message.exit);
        };
        const timeout = setTimeout(() => finish(new Error("Image RPC timed out")), 30_000);
        socket.on("message", onMessage);
        socket.on("close", onClose);
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: requestId,
            tag: "workspace.readScreenshotArtifact",
            payload,
            headers: [],
          }),
        );
      });
    try {
      const chunks = [];
      let offset = 0;
      while (offset < png.length) {
        const exit = await rpc({ artifactId, source: "attachment", offset, limit: 16 });
        assert.equal(exit._tag, "Success", "Attachment read must succeed");
        const chunk = exit.value;
        assert.equal(chunk.artifactId, artifactId);
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.totalBytes, png.length);
        assert.equal(chunk.mimeType, "image/png");
        const bytes = Buffer.from(chunk.dataBase64, "base64");
        assert.ok(bytes.length > 0 && bytes.length <= 16);
        chunks.push(bytes);
        offset += bytes.length;
        assert.equal(chunk.nextOffset, offset === png.length ? null : offset);
      }
      assert.deepEqual(Buffer.concat(chunks), png);
      const wrongSource = await rpc({ artifactId, source: "artifact", offset: 0, limit: 16 });
      assert.equal(wrongSource._tag, "Failure", "Attachments must not resolve as artifacts");
    } finally {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
  };
  await read();
  await request("connection", "DELETE");
  await request("connection", "POST");
  await read();
  console.log(
    "PASS: real Coder image upload, bounded helper reads, source isolation, and helper reconnect persistence.",
  );
}
