// @effect-diagnostics nodeBuiltinImport:off
import { rejects } from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import type * as Sdk from "@anthropic-ai/claude-agent-sdk";

import { buildClaudeCliArgs, query, type SDKUserMessage } from "./ClaudeCli.ts";

describe("ClaudeCli", () => {
  it("builds a locked-down streaming invocation", () => {
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      sessionId: "session-id",
    });

    assert.deepEqual(args.slice(0, 6), [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--print",
    ]);
    assert.equal(args[args.indexOf("--thinking-display") + 1], "summarized");
    assert.ok(!args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--mcp-config"));
    assert.ok(!args.includes("--chrome"));
    assert.ok(!args.includes("--plugin-dir"));
  });

  it("forks a rewind at an explicit assistant boundary without modifying the source session", () => {
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      resume: "source-session",
      resumeSessionAt: "assistant-one",
      forkSession: true,
      sessionId: "new-session",
    });
    assert.ok(args.includes("--fork-session"));
    assert.equal(args[args.indexOf("--resume") + 1], "source-session");
    assert.equal(args[args.indexOf("--resume-session-at") + 1], "assistant-one");
    assert.equal(args[args.indexOf("--session-id") + 1], "new-session");
  });

  it("passes MCP options to the CLI as the Agent SDK does", () => {
    const servers = { docs: { type: "http", url: "https://example.test/mcp" } };
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      mcpServers: servers,
      strictMcpConfig: true,
    });

    assert.equal(args[args.indexOf("--mcp-config") + 1], JSON.stringify({ mcpServers: servers }));
    assert.ok(args.includes("--strict-mcp-config"));
  });

  it("passes launch args through without overriding the transport flags", () => {
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      thinking: { type: "adaptive", display: "summarized" },
      extraArgs: {
        chrome: null,
        "max-turns": "5",
        "mcp-config": '{"mcpServers":{"x":{}}}',
        "strict-mcp-config": null,
        "output-format": "text",
        "thinking-display": "summarized",
      },
    });

    assert.ok(args.includes("--chrome"));
    assert.equal(args[args.indexOf("--max-turns") + 1], "5");
    assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{"x":{}}}');
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args.filter((arg) => arg === "--output-format").length, 1);
    assert.equal(args.filter((arg) => arg === "--thinking-display").length, 1);
  });

  it("preserves bounded directories and emits settings exactly once", () => {
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      additionalDirectories: ["/workspace/project with spaces", "/home/dev/.t3-coder/attachments"],
      settings: { autoCompactWindow: 160_000 },
    });

    assert.deepEqual(
      args.filter((arg, index) => args[index - 1] === "--add-dir"),
      ["/workspace/project with spaces", "/home/dev/.t3-coder/attachments"],
    );
    assert.equal(args.filter((arg) => arg === "--settings").length, 1);
    assert.equal(args[args.indexOf("--settings") + 1], '{"autoCompactWindow":160000}');
  });

  it("streams prompts and responses through the workspace CLI stdio protocol", async () => {
    const temporaryDirectory = await NodeFS.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"),
    );
    const executablePath = NodePath.join(temporaryDirectory, "fake-claude");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
import * as readline from "node:readline";
process.stdout.write("Claude Startup Script\\nAuthentication verified\\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let dialogResolved = false;
let userReceived = false;
const finish = () => {
  if (!dialogResolved || !userReceived) return;
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: "workspace-session",
    parent_tool_use_id: null,
    uuid: "assistant-id",
    message: { content: [{ type: "text", text: "workspace reply" }] }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "workspace-session",
    is_error: false
  }) + "\\n");
};
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    if (process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {
      throw new Error("missing SDK entrypoint");
    }
    if (JSON.stringify(message.request.hooks) !== "{}") {
      throw new Error("missing SDK hooks payload");
    }
    if (JSON.stringify(message.request.supportedDialogKinds) !== '["resume_return"]') {
      throw new Error("missing supported dialog kinds");
    }
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], account: { email: "workspace@example.test" } }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "dialog-1",
      request: {
        subtype: "request_user_dialog",
        dialog_kind: "resume_return",
        payload: { age_ms: 4200000, context_size: 120000 }
      }
    }) + "\\n");
  }
  if (message.type === "control_response" && message.response.request_id === "dialog-1") {
    if (message.response.response.behavior !== "completed" || message.response.response.result !== "compact") {
      throw new Error("invalid dialog response");
    }
    dialogResolved = true;
    finish();
  }
  if (message.type === "user") {
    userReceived = true;
    finish();
  }
}
`,
      { mode: 0o700 },
    );

    try {
      let resolveDialogHandled: (() => void) | undefined;
      const dialogHandled = new Promise<void>((resolve) => {
        resolveDialogHandled = resolve;
      });
      let dialogRequest: unknown;
      const runtime = query({
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          yield {
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: "hello" },
          };
          await dialogHandled;
          await new Promise((resolve) => setTimeout(resolve, 25));
        })(),
        options: {
          pathToClaudeCodeExecutable: executablePath,
          env: process.env,
          supportedDialogKinds: ["resume_return"],
          onUserDialog: async (request) => {
            dialogRequest = request;
            resolveDialogHandled?.();
            return { behavior: "completed", result: "compact" };
          },
        },
      });

      const initialization = await runtime.initializationResult();
      assert.deepEqual(initialization.commands, []);

      const messages = [];
      for await (const message of runtime) messages.push(message);
      assert.deepEqual(
        messages.map((message) => message.type),
        ["assistant", "result"],
      );
      assert.deepEqual(dialogRequest, {
        dialogKind: "resume_return",
        payload: { age_ms: 4_200_000, context_size: 120_000 },
      });
      runtime.close();
    } finally {
      await NodeFS.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("delivers a tool_result line larger than a megabyte intact", async () => {
    const temporaryDirectory = await NodeFS.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-large-"),
    );
    const executablePath = NodePath.join(temporaryDirectory, "fake-claude");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
import * as readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request.subtype !== "initialize") continue;
  send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [] } } });
  send({
    type: "user",
    session_id: "workspace-session",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2 * 1024 * 1024) } }]
      }]
    }
  });
  send({ type: "result", subtype: "success", session_id: "workspace-session", is_error: false });
  lines.close();
  process.stdin.destroy();
}
`,
      { mode: 0o700 },
    );

    try {
      const runtime = query({
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
        options: { pathToClaudeCodeExecutable: executablePath, env: process.env },
      });
      await runtime.initializationResult();
      const messages = [];
      for await (const message of runtime) messages.push(message);
      assert.deepEqual(
        messages.map((message) => message.type),
        ["user", "result"],
      );
      const content = (messages[0] as { message: { content: unknown } }).message.content;
      assert.equal(
        (content as Array<{ content: Array<{ source: { data: string } }> }>)[0]?.content[0]?.source
          .data,
        "A".repeat(2 * 1024 * 1024),
      );
      runtime.close();
    } finally {
      await NodeFS.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  for (const testCase of [
    {
      name: "malformed control responses",
      output: 'JSON.stringify({ type: "control_response", response: "invalid" }) + "\\n"',
      expected: "response",
    },
    {
      name: "control responses with missing fields",
      output: 'JSON.stringify({ type: "control_response" }) + "\\n"',
      expected: "response",
    },
    {
      name: "truncated JSON",
      output: `'{' + '"type":"control_response"' + "\\n"`,
      expected: "JSON",
    },
    {
      name: "oversized lines",
      output: '"x".repeat(32 * 1024 * 1024 + 1)',
      expected: "oversized",
    },
  ]) {
    it(`fails the session for ${testCase.name} without crashing the process`, async () => {
      const temporaryDirectory = await NodeFS.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-invalid-"),
      );
      const executablePath = NodePath.join(temporaryDirectory, "fake-claude");
      await NodeFS.writeFile(
        executablePath,
        `#!/usr/bin/env node
process.stdout.write(${testCase.output});
setInterval(() => undefined, 1_000);
`,
        { mode: 0o700 },
      );

      try {
        const runtime = query({
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await new Promise(() => undefined);
          })(),
          options: {
            pathToClaudeCodeExecutable: executablePath,
            env: process.env,
          },
        });

        await rejects(runtime.initializationResult(), new RegExp(testCase.expected, "iu"));
        runtime.close();
      } finally {
        await NodeFS.rm(temporaryDirectory, { recursive: true, force: true });
      }
    });
  }
});

it("drains a burst without dropping messages and serves control requests while consumption is paused", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-backpressure-"));
  const executable = NodePath.join(directory, "fake-claude");
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {}
`.replace(
      "for await (const line of createInterface({ input: process.stdin })) {}",
      `
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type !== "control_request") return;
  send({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: { ready: true } } });
  if (value.request.subtype === "initialize") {
    for (let index = 0; index < 600; index++) send({ type: "assistant", uuid: String(index), message: { content: "x".repeat(4096) } });
  }
  if (value.request.subtype === "get_settings") process.stdin.destroy();
});`,
    ),
  );
  await NodeFS.chmod(executable, 0o700);
  let finishPrompt!: () => void;
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const pause = vi.spyOn(Readable.prototype, "pause");
  const runtime = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptFinished;
    })(),
    options: { pathToClaudeCodeExecutable: executable, env: process.env },
  });
  try {
    await runtime.initializationResult();
    await vi.waitFor(
      () =>
        assert.ok(
          pause.mock.contexts.some((stream) => stream instanceof Readable && stream.isPaused()),
        ),
      {
        timeout: 2000,
      },
    );
    assert.deepEqual(await runtime.getSettings(2000), { ready: true });
    finishPrompt();
    const ids: string[] = [];
    for await (const message of runtime) if (message.type === "assistant") ids.push(message.uuid);
    assert.deepEqual(
      ids,
      Array.from({ length: 600 }, (_, index) => String(index)),
    );
  } finally {
    finishPrompt();
    runtime.close();
    pause.mockRestore();
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("stops a native subagent with the Agent SDK's stop_task control request", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-stop-task-"));
  const executable = NodePath.join(directory, "fake-claude");
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type !== "control_request") return;
  const ok = value.request.subtype === "initialize" ||
    (value.request.subtype === "stop_task" && value.request.task_id === "task-7");
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: ok
      ? { subtype: "success", request_id: value.request_id, response: {} }
      : { subtype: "error", request_id: value.request_id, error: JSON.stringify(value.request) },
  }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  let finishPrompt!: () => void;
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const runtime = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptFinished;
    })(),
    options: { pathToClaudeCodeExecutable: executable, env: process.env },
  });
  try {
    await runtime.initializationResult();
    await runtime.stopTask("task-7");
    await rejects(runtime.stopTask("task-8"));
  } finally {
    finishPrompt();
    runtime.close();
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("backgrounds a foreground task with the Agent SDK's background_tasks control request", async () => {
  const directory = await NodeFS.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-claude-background-tasks-"),
  );
  const executable = NodePath.join(directory, "fake-claude");
  // Answers only the SDK 0.3.276 wire shape: `{ subtype: "background_tasks", tool_use_id }`,
  // with `backgrounded` false for an unknown call and absent for a build that backgrounds all.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type !== "control_request") return;
  const request = value.request;
  const keys = Object.keys(request).sort().join(",");
  const ok = request.subtype === "initialize" ||
    (request.subtype === "background_tasks" && (keys === "subtype" || keys === "subtype,tool_use_id"));
  const response = request.tool_use_id === "toolu_unknown" ? { backgrounded: false } : {};
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: ok
      ? { subtype: "success", request_id: value.request_id, response }
      : { subtype: "error", request_id: value.request_id, error: JSON.stringify(request) },
  }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  let finishPrompt!: () => void;
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const runtime = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptFinished;
    })(),
    options: { pathToClaudeCodeExecutable: executable, env: process.env },
  });
  try {
    await runtime.initializationResult();
    assert.equal(await runtime.backgroundTasks("toolu_1"), true);
    assert.equal(await runtime.backgroundTasks(), true);
    assert.equal(await runtime.backgroundTasks("toolu_unknown"), false);
  } finally {
    finishPrompt();
    runtime.close();
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("registers MCP servers with the Agent SDK's mcp_set_servers control request", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-mcp-servers-"));
  const executable = NodePath.join(directory, "fake-claude");
  const servers = {
    docs: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
  };
  // Answers only the SDK 0.3.276 wire shape: `{ subtype: "mcp_set_servers", servers }`.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const expected = ${JSON.stringify(JSON.stringify(servers))};
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type !== "control_request") return;
  const request = value.request;
  const keys = Object.keys(request).sort().join(",");
  const ok = request.subtype === "initialize" ||
    (request.subtype === "mcp_set_servers" && keys === "servers,subtype" &&
      JSON.stringify(request.servers) === expected && !process.argv.includes("--mcp-config"));
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: ok
      ? {
          subtype: "success",
          request_id: value.request_id,
          response: request.subtype === "initialize"
            ? {}
            : { added: ["docs"], removed: [], errors: {} },
        }
      : { subtype: "error", request_id: value.request_id, error: JSON.stringify(request) },
  }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  let finishPrompt!: () => void;
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const runtime = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptFinished;
    })(),
    options: { pathToClaudeCodeExecutable: executable, env: process.env },
  });
  try {
    assert.deepEqual(await runtime.setMcpServers(servers), {
      added: ["docs"],
      removed: [],
      errors: {},
    });
    await rejects(runtime.setMcpServers({ other: servers.docs }));
  } finally {
    finishPrompt();
    runtime.close();
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("applies flag settings with the Agent SDK's apply_flag_settings control request", async () => {
  const directory = await NodeFS.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-claude-flag-settings-"),
  );
  const executable = NodePath.join(directory, "fake-claude");
  const settings = { effortLevel: "high", fastMode: null, ultracode: null };
  // Answers only the SDK 0.3.276 wire shape: `{ subtype: "apply_flag_settings", settings }`.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const expected = ${JSON.stringify(JSON.stringify(settings))};
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type !== "control_request") return;
  const request = value.request;
  const keys = Object.keys(request).sort().join(",");
  const ok = request.subtype === "initialize" ||
    (request.subtype === "apply_flag_settings" && keys === "settings,subtype" &&
      JSON.stringify(request.settings) === expected);
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: ok
      ? { subtype: "success", request_id: value.request_id, response: {} }
      : { subtype: "error", request_id: value.request_id, error: JSON.stringify(request) },
  }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  let finishPrompt!: () => void;
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  const runtime = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptFinished;
    })(),
    options: { pathToClaudeCodeExecutable: executable, env: process.env },
  });
  try {
    await runtime.applyFlagSettings(settings);
    await rejects(runtime.applyFlagSettings({ effortLevel: "low" }));
  } finally {
    finishPrompt();
    runtime.close();
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("starts the CLI through a caller's spawner, as the Agent SDK's spawnClaudeCodeProcess does", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-spawner-"));
  const executable = NodePath.join(directory, "fake-claude");
  // Answers initialize, then prints a result for the prompt and exits at once.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "control_request") {
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: value.request_id, response: {} },
    }) + "\\n");
    return;
  }
  if (value.type === "user") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", cwd: process.cwd() }) + "\\n", () => process.exit(0));
  }
});
`,
    { mode: 0o700 },
  );
  const spawned: Array<Sdk.SpawnOptions> = [];
  const spawner = (options: Sdk.SpawnOptions): Sdk.SpawnedProcess => {
    spawned.push(options);
    return spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
  };
  try {
    const runtime = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content: "hello" },
        };
      })(),
      options: {
        pathToClaudeCodeExecutable: executable,
        executableArgs: ["--wrapper-arg"],
        cwd: directory,
        env: process.env,
        spawnClaudeCodeProcess: spawner,
      },
    });
    const messages: Array<unknown> = [];
    for await (const message of runtime) messages.push(message);
    assert.deepEqual(messages, [
      { type: "result", subtype: "success", cwd: await NodeFS.realpath(directory) },
    ]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.command, executable);
    assert.deepEqual(spawned[0]?.args.slice(0, 3), [
      "--wrapper-arg",
      "--output-format",
      "stream-json",
    ]);
    assert.equal(spawned[0]?.cwd, directory);
    assert.equal(spawned[0]?.env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");

    // Closing a live session aborts the spawner's signal, as the SDK does.
    let finishPrompt!: () => void;
    const promptFinished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const live = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await promptFinished;
      })(),
      options: {
        pathToClaudeCodeExecutable: executable,
        env: process.env,
        spawnClaudeCodeProcess: spawner,
      },
    });
    await live.initializationResult();
    assert.equal(spawned[1]?.signal.aborted, false);
    live.close();
    finishPrompt();
    assert.equal(spawned[1]?.signal.aborted, true);
  } finally {
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("hands can_use_tool's ask rule and standing-grant flag to canUseTool, as the Agent SDK does", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-can-use-tool-"));
  const executable = NodePath.join(directory, "fake-claude");
  // Asks once with the SDK 0.3.276 can_use_tool wire shape, then reports the answer as a result.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "control_request") {
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: value.request_id, response: {} },
    }) + "\\n");
    return;
  }
  if (value.type === "user") {
    process.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "ask-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf build" },
        tool_use_id: "tool-1",
        decision_reason: "Matches an ask rule",
        suppress_always_allow_rule: true,
        matched_ask_rule: { source: "projectSettings", tool_name: "Bash", rule_content: "rm:*" },
      },
    }) + "\\n");
    return;
  }
  if (value.type === "control_response") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", answer: value.response.response }) + "\\n", () => process.exit(0));
  }
});
`,
    { mode: 0o700 },
  );
  const asked: Array<Parameters<Sdk.CanUseTool>[2]> = [];
  try {
    const runtime = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content: "hello" },
        };
      })(),
      options: {
        pathToClaudeCodeExecutable: executable,
        env: process.env,
        canUseTool: async (_toolName, _input, options) => {
          asked.push(options);
          return { behavior: "deny", message: "No." };
        },
      },
    });
    for await (const _message of runtime) {
      // Drain until the fake CLI exits.
    }
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.decisionReason, "Matches an ask rule");
    assert.equal(asked[0]?.suppressAlwaysAllowRule, true);
    assert.deepEqual(asked[0]?.matchedAskRule, {
      source: "projectSettings",
      toolName: "Bash",
      ruleContent: "rm:*",
    });
  } finally {
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);

it("hands an MCP elicitation to onElicitation and answers it, as the Agent SDK does", async () => {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-elicitation-"));
  const executable = NodePath.join(directory, "fake-claude");
  // Asks once with the SDK 0.3.276 elicitation wire shape, then reports the answer as a result.
  await NodeFS.writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "control_request") {
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: value.request_id, response: {} },
    }) + "\\n");
    return;
  }
  if (value.type === "user") {
    process.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "elicit-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "deploys",
        message: "Deploy web?",
        mode: "form",
        requested_schema: { type: "object", properties: {} },
        display_name: "Deploys",
      },
    }) + "\\n");
    return;
  }
  if (value.type === "control_response") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s", is_error: false, answer: value.response }) + "\\n", () => process.exit(0));
  }
});
`,
    { mode: 0o700 },
  );
  const asked: Array<Sdk.ElicitationRequest> = [];
  const answers: Array<unknown> = [];
  let resolveAnswered: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => {
    resolveAnswered = resolve;
  });
  try {
    const runtime = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content: "hello" },
        };
        // Keep input open until the CLI has reported the answer.
        await answered;
      })(),
      options: {
        pathToClaudeCodeExecutable: executable,
        env: process.env,
        onElicitation: async (request, options) => {
          asked.push(request);
          assert.equal(options.requestId, "elicit-1");
          return { action: "accept", content: {} };
        },
      },
    });
    for await (const message of runtime) {
      if (message.type !== "result") continue;
      answers.push((message as { answer?: unknown }).answer);
      resolveAnswered?.();
    }
    assert.deepEqual(asked, [
      {
        serverName: "deploys",
        message: "Deploy web?",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
        displayName: "Deploys",
      },
    ]);
    assert.deepEqual(answers, [
      {
        subtype: "success",
        request_id: "elicit-1",
        response: { action: "accept", content: {} },
      },
    ]);
  } finally {
    await NodeFS.rm(directory, { force: true, recursive: true });
  }
}, 5000);
