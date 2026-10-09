// Real-provider check for the v2 orchestrator over the Coder gateway. Each provider gets one turn
// that receives an uploaded image and calls a T3 tool through the workspace bridge; the check then
// reads a project image on demand and verifies its ownership and containment rules.
//
// Requires authenticated, real Codex and Claude Code CLIs. A missing reply, a tool call that never
// happened, or an approval request fails the check; nothing is simulated.
//
//   node scripts/coder-live-provider-images.mjs --local
//     Runs the workspace helper on this machine against a temporary T3 Coder home and project,
//     using the `codex` and `claude` on PATH with their own sign-in. Uploads are copied into the
//     helper's attachment directory instead of going through SCP. Turns use real provider quota.
//
//   node scripts/coder-live-provider-images.mjs --gateway <url> --workspace <id> --project-root <path>
//     Uses a running gateway and a connected workspace. <path> must hold the fixture image as
//     `fixture.png` (see `png` in coder-live-images.mjs).
//
// Options: --instances codex,claudeAgent  --claude-model <slug>  --codex-model <slug>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs/promises";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { png } from "./coder-live-images.mjs";

const requireGateway = createRequire(
  new URL("../apps/coder-gateway/package.json", import.meta.url),
);
const { WebSocket } = requireGateway("ws");

const TURN_TIMEOUT_MS = 300_000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const COLOR_WORDS =
  /\b(red|green|blue|yellow|orange|purple|pink|black|white|gr[ae]y|cyan|magenta|teal)\b/i;

function connectRpc(url, workspaceId) {
  const endpoint = `${url}/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/rpc`, { origin: url });
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
  return { endpoint, socket, rpc };
}

function pickModel(provider, preferred, cheap) {
  if (preferred) return preferred;
  const models = (provider?.models ?? []).map((model) => model.slug ?? model.id).filter(Boolean);
  return models.find((slug) => cheap.test(slug)) ?? models[0];
}

/** Runs the check against a gateway whose workspace already has `projectRoot/fixture.png`. */
export async function testLiveProviderImages(
  url,
  workspaceId,
  { projectRoot, instances = ["codex", "claudeAgent"], models = {} },
) {
  const endpoint = `${url}/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const connected = await fetch(`${endpoint}/connection`, {
    method: "POST",
    headers: { Origin: url },
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(connected.status, 200, `Workspace connection failed: ${await connected.text()}`);
  // Opened only once the workspace is connected, so the open event cannot be missed.
  const { socket, rpc } = connectRpc(url, workspaceId);
  await once(socket, "open", { signal: AbortSignal.timeout(30_000) });
  const results = [];
  try {
    const config = await rpc("server.getConfig", {});
    const projectId = randomUUID();
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "Live provider check",
      workspaceRoot: projectRoot,
      createWorkspaceRootIfMissing: false,
    });

    for (const instanceId of instances) {
      // Codex reports its models from a startup probe; wait for it rather than racing it.
      let provider = config.providers.find((entry) => entry.instanceId === instanceId);
      const providerDeadline = Date.now() + 120_000;
      while (provider?.enabled && provider.models.length === 0 && Date.now() < providerDeadline) {
        await delay(2_000);
        provider = (await rpc("server.getConfig", {})).providers.find(
          (entry) => entry.instanceId === instanceId,
        );
      }
      assert.ok(provider, `${instanceId} is not configured in the workspace`);
      assert.equal(provider.enabled, true, `${instanceId} is disabled`);
      const model = pickModel(
        provider,
        models[instanceId],
        instanceId === "claudeAgent" ? /haiku/i : /mini/i,
      );
      assert.ok(model, `${instanceId} reports no models`);

      const uploaded = await fetch(`${endpoint}/clipboard-image`, {
        method: "POST",
        headers: { Origin: url, "Content-Type": "image/png" },
        body: png,
        signal: AbortSignal.timeout(180_000),
      });
      assert.equal(uploaded.status, 200, `Image upload failed: ${await uploaded.clone().text()}`);
      const { attachment } = await uploaded.json();
      assert.match(attachment.id, /^pending-[0-9a-f-]{36}-png$/);

      const launched = await rpc(
        "orchestration.launchThread",
        {
          commandId: randomUUID(),
          // Uploaded attachments are claimed into the thread, so it is named up front.
          threadId: randomUUID(),
          projectId,
          title: `${instanceId} live provider check`,
          modelSelection: { instanceId, model },
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            text: [
              "This is an automated check. Do not modify any files.",
              "1. In one short sentence, name the dominant color of the attached image.",
              "2. Using the T3 tools shell command described in your instructions, run its `t3_thread_list` tool once and say how many threads it returned.",
            ].join("\n"),
            attachments: [{ type: "image", name: "fixture.png", ...attachment }],
          },
        },
        120_000,
      );
      const threadId = launched.threadId;

      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let projection = launched.projection;
      let run;
      while (Date.now() < deadline) {
        projection = await rpc("orchestration.getThreadProjection", { threadId });
        const pending = projection.runtimeRequests.find((request) => request.status === "pending");
        if (pending) {
          await rpc("orchestration.dispatchCommand", {
            type: "runtime-request.respond",
            commandId: randomUUID(),
            threadId,
            requestId: pending.id,
            decision: "decline",
          }).catch(() => undefined);
          assert.fail(`${instanceId} asked for approval (${pending.kind}); the check declined it`);
        }
        run = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (run && TERMINAL_RUN_STATUSES.has(run.status)) break;
        await delay(2_000);
      }
      assert.equal(
        run?.status,
        "completed",
        `${instanceId} turn ended as ${run?.status ?? "running"}`,
      );

      const reply = projection.messages
        .filter((message) => message.role === "assistant" && message.runId === run.id)
        .map((message) => message.text)
        .join("\n");
      assert.ok(reply.trim().length > 0, `${instanceId} sent no reply`);
      assert.match(reply, COLOR_WORDS, `${instanceId} did not describe the image's color`);
      const items = JSON.stringify(projection.turnItems);
      assert.ok(
        items.includes("t3_thread_list") && items.includes("t3.mjs"),
        `${instanceId} did not call t3_thread_list through the T3 tool bridge`,
      );

      const chunks = [];
      let offset = 0;
      let first;
      do {
        const chunk = await rpc("projects.readImage", {
          threadId,
          cwd: projectRoot,
          filePath: "fixture.png",
          offset,
          limit: 512 * 1024,
          ...(first ? { revision: first.revision } : {}),
        });
        first ??= chunk;
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.revision, first.revision);
        const bytes = Buffer.from(chunk.dataBase64, "base64");
        assert.ok(bytes.length > 0);
        chunks.push(bytes);
        offset += bytes.length;
        assert.equal(chunk.nextOffset, offset === first.totalBytes ? null : offset);
      } while (offset < first.totalBytes);
      assert.deepEqual(Buffer.concat(chunks), png, "Project image bytes must match the file");
      const parent = NodePath.posix.dirname(projectRoot);
      for (const input of [
        { threadId: randomUUID(), cwd: projectRoot, filePath: "fixture.png" },
        { threadId, cwd: parent, filePath: `${NodePath.posix.basename(projectRoot)}/fixture.png` },
        { threadId, cwd: projectRoot, filePath: "https://example.com/outside.png" },
      ])
        await assert.rejects(rpc("projects.readImage", { ...input, offset: 0, limit: 512 }));

      results.push({ instanceId, model, threadId, reply });
      console.log(
        `PASS: ${instanceId} (${model}) image turn, T3 tool bridge, and project image reads.`,
      );
      console.log(`      reply: ${reply.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    return results;
  } finally {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
}

async function runLocal(options) {
  const [{ startLocalCoderGateway }, { saveCoderProfileConfig }, helperConnection] =
    await Promise.all([
      import("../apps/coder-gateway/src/testUtils/gateway.ts"),
      import("../packages/coder-cli/src/configStore.ts"),
      import("../packages/coder-cli/src/helperConnection.ts"),
    ]);
  const requireCoderCli = createRequire(
    new URL("../packages/coder-cli/package.json", import.meta.url),
  );
  const Effect = requireCoderCli("effect/Effect");
  const Exit = requireCoderCli("effect/Exit");
  const Scope = requireCoderCli("effect/Scope");

  const repositoryRoot = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)));
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-live-providers-"));
  const coderHome = NodePath.join(root, "t3-coder-home");
  const projectRoot = NodePath.join(root, "project");
  const attachmentsDir = NodePath.join(coderHome, "attachments");
  await NodeFS.mkdir(projectRoot, { recursive: true });
  await NodeFS.mkdir(attachmentsDir, { recursive: true });
  await NodeFS.writeFile(NodePath.join(projectRoot, "fixture.png"), png);
  await NodeFS.writeFile(NodePath.join(projectRoot, "README.md"), "# Live provider check\n");
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "."],
    [
      "-c",
      "user.name=T3 Coder",
      "-c",
      "user.email=t3coder@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
  }

  const configPath = NodePath.join(root, "gateway", "config.json");
  await saveCoderProfileConfig(configPath, {
    version: 1,
    deployments: [{ id: "local-providers", name: "Local providers", url: "https://coder.invalid" }],
    workspaces: [
      {
        id: "local-providers-workspace",
        name: "Local provider check",
        deploymentId: "local-providers",
        workspace: "local/providers",
      },
    ],
    portForwards: [],
  });
  // The real provider CLIs keep their sign-in under the user's home, so HOME stays as it is;
  // T3 Coder's own state lives in the temporary home.
  const environment = {
    ...process.env,
    T3_CODER_HOME: coderHome,
    T3_CODER_CWD: projectRoot,
    T3_CODER_WORKSPACE_LABEL: "Local provider check",
  };
  const helperPath = NodePath.join(repositoryRoot, "apps", "coder-helper", "src", "bin.ts");
  const connectHelper = async () => {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const connection = await Effect.runPromise(
      helperConnection
        .connectCoderHelper(
          { executable: process.execPath, args: [helperPath] },
          { environment, terminationGraceMs: 2_000 },
        )
        .pipe(Scope.provide(scope)),
    );
    const closed = Effect.runPromise(connection.closed);
    void closed
      .finally(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      .catch(() => undefined);
    return {
      ...connection,
      closed,
      sendRpc: (message) => Effect.runSync(connection.sendRpc(message)),
      close: () => void Effect.runPromise(connection.close).catch(() => undefined),
    };
  };

  const gateway = await startLocalCoderGateway({
    configPath,
    checkAuthentication: async () => "authenticated",
    probeWorkspace: async () => undefined,
    connectHelper,
    // Local mode stands in for SCP: the staged file lands where the helper claims uploads.
    uploadComposerAttachment: async ({ localPath, extension }) => {
      const target = NodePath.join(
        attachmentsDir,
        `pending-${randomUUID()}-${extension}.${extension}`,
      );
      await NodeFS.copyFile(localPath, target);
      return target;
    },
  });
  let passed = false;
  try {
    await testLiveProviderImages(gateway.url, "local-providers-workspace", {
      ...options,
      projectRoot,
    });
    passed = true;
  } finally {
    await gateway.close();
    if (passed) await NodeFS.rm(root, { recursive: true, force: true });
    else console.error(`Kept the check's temporary files for inspection: ${root}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: "boolean", default: false },
      gateway: { type: "string" },
      workspace: { type: "string" },
      "project-root": { type: "string" },
      instances: { type: "string", default: "codex,claudeAgent" },
      "claude-model": { type: "string" },
      "codex-model": { type: "string" },
    },
  });
  const options = {
    instances: values.instances
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    models: {
      ...(values["claude-model"] ? { claudeAgent: values["claude-model"] } : {}),
      ...(values["codex-model"] ? { codex: values["codex-model"] } : {}),
    },
  };
  if (values.local) {
    await runLocal(options);
    return;
  }
  if (!values.gateway || !values.workspace || !values["project-root"]) {
    throw new Error("Use --local, or --gateway <url> --workspace <id> --project-root <path>.");
  }
  await testLiveProviderImages(values.gateway, values.workspace, {
    ...options,
    projectRoot: values["project-root"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
