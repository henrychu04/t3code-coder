// @effect-diagnostics nodeBuiltinImport:off
import { rejects } from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { buildClaudeCliArgs, query, type SDKUserMessage } from "./ClaudeCli.ts";

describe("ClaudeCli", () => {
  it("builds a locked-down streaming invocation", () => {
    const args = buildClaudeCliArgs({
      pathToClaudeCodeExecutable: "claude",
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
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
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.ok(!args.includes("--chrome"));
    assert.ok(!args.includes("--plugin-dir"));
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
      output: '"x".repeat(1024 * 1024 + 1)',
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
