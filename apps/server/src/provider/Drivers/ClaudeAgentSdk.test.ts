// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  claudeProjectDirectoryName,
  getSubagentMessages,
  query,
  toClaudeCliOptions,
} from "./ClaudeAgentSdk.ts";
import { buildClaudeCliArgs } from "./ClaudeCli.ts";

describe("ClaudeAgentSdk", () => {
  it("maps SDK options onto the CLI transport and keeps MCP disabled", () => {
    const args = buildClaudeCliArgs(
      toClaudeCliOptions({
        pathToClaudeCodeExecutable: "claude",
        model: "claude-fable-5-1",
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools: ["WebFetch"],
        permissionMode: "acceptEdits",
        resume: "11111111-1111-4111-8111-111111111111",
        resumeSessionAt: "assistant-id",
        settings: "/workspace/.claude/settings.json",
        systemPrompt: { type: "preset", preset: "claude_code", append: "Extra." },
        mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } },
        extraArgs: { "max-turns": "5" },
      }),
    );
    assert.equal(args[args.indexOf("--tools") + 1], "default");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "WebFetch");
    assert.equal(args[args.indexOf("--settings") + 1], "/workspace/.claude/settings.json");
    assert.equal(args[args.indexOf("--resume") + 1], "11111111-1111-4111-8111-111111111111");
    assert.equal(args[args.indexOf("--max-turns") + 1], "5");
    assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.ok(!args.join(" ").includes("127.0.0.1"));
  });

  it("rejects options the CLI transport cannot honour", () => {
    const base = { pathToClaudeCodeExecutable: "claude" };
    assert.throws(() => toClaudeCliOptions({ ...base, hooks: {} }), /hooks/);
    assert.throws(() => toClaudeCliOptions({ ...base, systemPrompt: "Custom." }), /system prompt/);
    assert.throws(
      () => toClaudeCliOptions({ ...base, thinking: { type: "disabled" } }),
      /thinking/,
    );
    assert.throws(() => toClaudeCliOptions({}), /executable/);
  });

  it("streams through the workspace CLI with the SDK query surface", async () => {
    const temporaryDirectory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sdk-"));
    const executablePath = NodePath.join(temporaryDirectory, "fake-claude");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
import * as readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    if (message.request.appendSystemPrompt !== "Extra.") throw new Error("missing appended prompt");
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [{ name: "review", description: "", argumentHint: "" }] }
      }
    }) + "\\n");
  }
  if (message.type === "user") {
    process.stdout.write(JSON.stringify({
      type: "assistant", session_id: "s", parent_tool_use_id: null, uuid: "a",
      message: { content: [{ type: "text", text: "hi" }] }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", session_id: "s", is_error: false
    }) + "\\n");
  }
}
`,
      { mode: 0o700 },
    );
    try {
      const runtime = query({
        prompt: "hello",
        options: {
          pathToClaudeCodeExecutable: executablePath,
          systemPrompt: { type: "preset", preset: "claude_code", append: "Extra." },
        },
      });
      assert.deepEqual(
        (await runtime.supportedCommands()).map((command) => command.name),
        ["review"],
      );
      const types: string[] = [];
      for await (const message of runtime) {
        types.push(message.type);
        if (message.type === "result") break;
      }
      assert.deepEqual(types, ["assistant", "result"]);
      await runtime.rewindFiles("message").then(
        () => assert.fail("expected an unsupported control request"),
        (error: Error) => assert.match(error.message, /not available/),
      );
      runtime.close();
    } finally {
      await NodeFS.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reads a subagent's messages and launching tool call from the transcript store", async () => {
    const configDirectory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-"));
    const workspace = await NodeFS.realpath(
      await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-")),
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirectory;
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const projectDirectory = NodePath.join(
      configDirectory,
      "projects",
      claudeProjectDirectoryName(workspace),
    );
    const subagents = NodePath.join(projectDirectory, sessionId, "subagents", "nested");
    try {
      await NodeFS.mkdir(subagents, { recursive: true });
      await NodeFS.writeFile(NodePath.join(projectDirectory, `${sessionId}.jsonl`), "{}\n");
      const line = (value: Record<string, unknown>) => JSON.stringify(value);
      await NodeFS.writeFile(
        NodePath.join(subagents, "agent-worker.jsonl"),
        [
          line({
            type: "user",
            uuid: "u1",
            parentUuid: null,
            sessionId,
            message: { content: "go" },
          }),
          line({ type: "assistant", uuid: "abandoned", parentUuid: "u1", sessionId, message: {} }),
          line({
            type: "assistant",
            uuid: "a1",
            parentUuid: "u1",
            sessionId,
            message: { id: "m" },
          }),
          "not json",
        ].join("\n"),
      );
      await NodeFS.writeFile(
        NodePath.join(subagents, "agent-worker.meta.json"),
        JSON.stringify({ toolUseId: "toolu_123", parentAgentId: "parent-agent" }),
      );

      const first = await getSubagentMessages(sessionId, "worker", { dir: workspace, limit: 1 });
      assert.deepEqual(
        first.map((message) => [message.uuid, message.parent_tool_use_id, message.parent_agent_id]),
        [["u1", "toolu_123", "parent-agent"]],
      );
      const all = await getSubagentMessages(sessionId, "worker");
      assert.deepEqual(
        all.map((message) => message.uuid),
        ["u1", "a1"],
      );
      assert.deepEqual(await getSubagentMessages(sessionId, "missing"), []);
      assert.deepEqual(await getSubagentMessages("not-a-session", "worker"), []);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await NodeFS.rm(configDirectory, { recursive: true, force: true });
      await NodeFS.rm(workspace, { recursive: true, force: true });
    }
  });
});
