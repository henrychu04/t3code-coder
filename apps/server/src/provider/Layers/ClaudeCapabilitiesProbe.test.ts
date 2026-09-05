import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  checkClaudeProviderStatus,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  probeClaudeCapabilities,
  providerModelsFromClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("Claude authentication status", (it) => {
  for (const testCase of [
    {
      name: "signed out despite initialized account metadata",
      output: '{"loggedIn":false}',
      code: 1,
      auth: "unauthenticated",
      status: "error",
    },
    {
      name: "signed in",
      output: '{"loggedIn":true}',
      code: 0,
      auth: "authenticated",
      status: "ready",
    },
    { name: "missing status", output: "{}", code: 0, auth: "unknown", status: "warning" },
    {
      name: "malformed status",
      output: "private invalid output",
      code: 0,
      auth: "unknown",
      status: "warning",
    },
    {
      name: "failed command with stale signed-in output",
      output: '{"loggedIn":true}',
      code: 2,
      auth: "unknown",
      status: "warning",
    },
    {
      name: "API-key authentication succeeds",
      output: '{"loggedIn":true}',
      code: 0,
      auth: "authenticated",
      status: "ready",
      tokenSource: "apiKey",
      backendType: "apiKey",
    },
    {
      name: "failed API-key auth retains identity without claiming readiness",
      output: '{"loggedIn":false}',
      code: 1,
      auth: "unauthenticated",
      status: "error",
      tokenSource: "apiKey",
      backendType: "apiKey",
    },
    {
      name: "Bedrock authentication succeeds",
      output: '{"loggedIn":true}',
      code: 0,
      auth: "authenticated",
      status: "ready",
      apiProvider: "bedrock",
      backendType: "bedrock",
    },
    {
      name: "Bedrock auth failure does not suggest OAuth login",
      output: '{"loggedIn":false}',
      code: 1,
      auth: "unauthenticated",
      status: "error",
      apiProvider: "bedrock",
      backendType: "bedrock",
    },
    {
      name: "unknown Bedrock auth retains identity without trusting initialization",
      output: "{}",
      code: 0,
      auth: "unknown",
      status: "warning",
      apiProvider: "bedrock",
      backendType: "bedrock",
    },
  ]) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-auth-" });
        const executable = path.join(tempDir, "fake-claude.mjs");
        yield* fs.writeFileString(
          executable,
          [
            "#!/usr/bin/env node",
            'if (process.argv[2] === "--version") { console.log("2.1.261 (Claude Code)"); process.exit(0); }',
            'if (process.argv.slice(2).join(" ") !== "auth status") process.exit(3);',
            `console.log(${JSON.stringify(testCase.output)});`,
            `process.exit(${testCase.code});`,
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);
        const result = yield* checkClaudeProviderStatus(
          decodeClaudeSettings({ binaryPath: executable, homePath: tempDir }),
          () =>
            Effect.succeed({
              email: "stale@example.com",
              subscriptionType: "pro",
              tokenSource: "tokenSource" in testCase ? testCase.tokenSource : "oauth",
              apiProvider: "apiProvider" in testCase ? testCase.apiProvider : "firstParty",
              models: [],
              slashCommands: [],
              autoModeDisabled: true,
              bypassPermissionsDisabled: true,
            }),
          process.env,
          tempDir,
        );
        assert.equal(result.auth.status, testCase.auth);
        assert.equal(result.status, testCase.status);
        if (testCase.auth !== "authenticated") assert.equal(result.auth.email, undefined);
        assert.equal(result.message?.includes("private invalid output") ?? false, false);
        if ("backendType" in testCase) {
          assert.equal(result.auth.type, testCase.backendType);
          assert.equal(result.message?.includes("claude auth login") ?? false, false);
        } else if (testCase.auth !== "authenticated") {
          assert.equal(result.auth.type, undefined);
        }
      }),
    );
  }
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
  });

  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "true");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it("uses Claude's reported model and permission capabilities as authoritative", () => {
  const models = providerModelsFromClaudeCapabilities({
    models: [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Balanced model",
        supportsAutoMode: false,
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "Most capable model",
        supportsAutoMode: true,
      },
    ],
    autoModeDisabled: true,
    bypassPermissionsDisabled: true,
  });

  assert.deepEqual(
    models.map((model) => model.slug),
    ["claude-sonnet-5", "claude-opus-5"],
  );
  assert.deepEqual(models[0]?.capabilities?.supportedRuntimeModes, [
    "approval-required",
    "auto-accept-edits",
  ]);
  assert.deepEqual(models[1]?.capabilities?.supportedRuntimeModes, [
    "approval-required",
    "auto-accept-edits",
  ]);
  assert.equal(
    models.some((model) => model.slug === "claude-fable-5"),
    false,
  );

  const unrestrictedModel = providerModelsFromClaudeCapabilities({
    models: [
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "Most capable model",
        supportsAutoMode: true,
      },
    ],
    autoModeDisabled: false,
    bypassPermissionsDisabled: false,
  })[0];
  assert.deepEqual(unrestrictedModel?.capabilities?.supportedRuntimeModes, [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ]);

  const customModel = providerModelsFromClaudeCapabilities({
    models: [],
    autoModeDisabled: false,
    bypassPermissionsDisabled: false,
    customModels: ["claude-custom"],
  })[0];
  assert.deepEqual(customModel?.capabilities?.supportedRuntimeModes, [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ]);
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          '  if (message.request?.subtype === "initialize") {',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [{",
          '          value: "sonnet",',
          '          resolvedModel: "claude-sonnet-5",',
          '          displayName: "Sonnet",',
          '          description: "Balanced model",',
          "          supportsAutoMode: false,",
          "        }],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "  return;",
          "  }",
          '  if (message.request?.subtype === "get_settings") {',
          // The same foreground CLI handles usage; no SDK or HTTP client is involved.
          "    process.stdout.write(JSON.stringify({",
          '      type: "control_response",',
          "      response: {",
          '        subtype: "success",',
          "        request_id: message.request_id,",
          '        response: { effective: { disableAutoMode: "disable", permissions: { disableBypassPermissionsMode: "disable" } } },',
          "      },",
          '    }) + "\\n");',
          "  }",
          '  if (message.request?.subtype === "get_usage") {',
          "    process.stdout.write(JSON.stringify({",
          '      type: "control_response",',
          "      response: {",
          '        subtype: "success",',
          "        request_id: message.request_id,",
          "        response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: null } } },",
          "      },",
          '    }) + "\\n");',
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.ok(capabilities?.usageCheckedAt);
      assert.ok(Number.isFinite(Date.parse(capabilities.usageCheckedAt)));
      assert.deepEqual(capabilities, {
        usageCheckedAt: capabilities.usageCheckedAt,
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 42, resets_at: null } },
        },
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        models: [
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            displayName: "Sonnet",
            description: "Balanced model",
            supportsAutoMode: false,
          },
        ],
        autoModeDisabled: true,
        bypassPermissionsDisabled: true,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), true);
      assert.deepEqual(invocation.mcpConfig, { mcpServers: {} });

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a valid init result when an older CLI ignores get_settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-old-cli-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { createInterface } from "node:readline";',
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          "        commands: [],",
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        process.env,
        tempDir,
      );

      assert.equal(capabilities?.email, "dev@example.com");
      assert.equal(capabilities?.subscriptionType, "pro");
      assert.equal(capabilities?.autoModeDisabled, true);
      assert.equal(capabilities?.bypassPermissionsDisabled, true);
    }).pipe(Effect.scoped),
  );
});
