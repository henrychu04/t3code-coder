import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { png } from "./coder-live-images.mjs";
import { DEFAULT_MODEL_BY_PROVIDER } from "../packages/contracts/src/model.ts";

const requireGateway = createRequire(
  new URL("../apps/coder-gateway/package.json", import.meta.url),
);
const { WebSocket } = requireGateway("ws");

// Requires authenticated real providers. Missing tool use is a failure, never a simulated pass.
export async function testLiveProviderImages(url, workspaceId) {
  const endpoint = `${url}/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const connected = await fetch(`${endpoint}/connection`, {
    method: "POST",
    headers: { Origin: url },
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(connected.status, 200, "Workspace connection failed");
  const uploaded = await fetch(`${endpoint}/clipboard-image`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "image/png" },
    body: png,
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(uploaded.status, 200, "Image upload failed");
  const attachmentId = (await uploaded.json()).path.split("/").at(-1);
  assert.match(attachmentId, /^[0-9a-f-]{36}\.png$/);

  const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/rpc`, { origin: url });
  await once(socket, "open", { signal: AbortSignal.timeout(30_000) });
  let id = 0;
  const rpc = (tag, payload) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const finish = (error, value) => {
        clearTimeout(timeout);
        socket.off("message", receive);
        socket.off("close", closed);
        if (error) reject(error);
        else resolve(value);
      };
      const closed = () => finish(new Error("Provider-check RPC disconnected"));
      const receive = (data) => {
        const message = JSON.parse(data.toString());
        if (message._tag !== "Exit" || message.requestId !== requestId) return;
        if (message.exit._tag !== "Success") return finish(new Error(`${tag} failed`));
        finish(undefined, message.exit.value);
      };
      const timeout = setTimeout(() => finish(new Error(`${tag} timed out`)), 30_000);
      socket.on("message", receive);
      socket.on("close", closed);
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
  const dispatch = (command) =>
    rpc("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  let activeThread;
  try {
    const previous = await rpc("orchestration.searchThreads", { query: "fixture.png", limit: 10 });
    const projectId = previous.matches[0]?.projectId ?? randomUUID();
    if (previous.matches.length === 0)
      await dispatch({
        type: "project.create",
        projectId,
        title: "Live provider image check",
        workspaceRoot: "/srv/t3-image-check",
        createWorkspaceRootIfMissing: false,
        createdAt: new Date().toISOString(),
      });
    for (const instanceId of ["codex", "claudeAgent"]) {
      const threadId = randomUUID();
      const modelSelection = { instanceId, model: DEFAULT_MODEL_BY_PROVIDER[instanceId] };
      assert.ok(modelSelection.model, "A supported model is required");
      // The container cannot run Codex filesystem sandboxing; the prompt only reads our fixture.
      const runtimeMode = instanceId === "codex" ? "full-access" : "approval-required";
      const interactionMode = "default";
      await dispatch({
        type: "thread.create",
        threadId,
        projectId,
        title: `${instanceId} image capture`,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
      activeThread = threadId;
      await dispatch({
        type: "thread.turn.start",
        attachments: [{ type: "image", id: attachmentId }],
        threadId,
        modelSelection,
        runtimeMode,
        interactionMode,
        message: {
          messageId: randomUUID(),
          role: "user",
          text: "Inspect the attached image, then use your image-viewing tool (Read or view_image) to inspect fixture.png in this project. Describe the image briefly and embed it using ![Inspected image](fixture.png). Do not modify any files or run shell commands.",
        },
        createdAt: new Date().toISOString(),
      });
      const snapshot = () =>
        rpc("orchestration.getThreadSnapshot", { threadId, turnLimit: 2, targetBytes: 512 * 1024 });
      const deadline = Date.now() + 180_000;
      let thread;
      while (Date.now() < deadline) {
        thread = (await snapshot()).thread;
        if (thread.latestTurn && thread.latestTurn.state !== "running") break;
        await delay(1_000);
      }
      assert.equal(
        thread?.latestTurn?.state,
        "completed",
        `${instanceId} image turn did not complete`,
      );
      activeThread = undefined;
      const images = thread.activities.flatMap((activity) => activity.payload?.artifacts ?? []);
      if (images.length === 0) {
        console.log(
          JSON.stringify({
            instanceId,
            threadId,
            sessionStatus: thread.session?.status,
            activities: thread.activities.map((a) => ({
              kind: a.kind,
              summary: a.summary,
              itemType: a.payload?.itemType,
              warning: a.payload?.imageCaptureWarning,
            })),
            replies: thread.messages.filter((m) => m.role === "assistant").map((m) => m.text),
          }),
        );
      }
      assert.ok(images.length > 0, `${instanceId} did not produce a captured image activity`);
      for (const image of images) {
        const chunk = await rpc("workspace.readScreenshotArtifact", {
          artifactId: image.id,
          offset: 0,
          limit: 512 * 1024,
        });
        assert.equal(chunk.totalBytes, image.sizeBytes);
        assert.ok(Buffer.from(chunk.dataBase64, "base64").length > 0);
      }
      const restored = (await snapshot()).thread;
      assert.deepEqual(
        restored.activities.flatMap((activity) => activity.payload?.artifacts ?? []),
        images,
      );
      console.log(
        `PASS: ${instanceId} real image-view tool, originating activity, and captured image read.`,
      );
    }
  } finally {
    if (activeThread)
      await dispatch({
        type: "thread.turn.interrupt",
        threadId: activeThread,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
}
