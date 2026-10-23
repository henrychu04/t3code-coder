import * as NodeAssert from "node:assert/strict";

import { t3ToolBridgeSections } from "@t3tools/provider-core/server/t3ToolBridgeInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });

  // Coder: a bridged session replaces the MCP sections with the T3 tool bridge's.
  it("keeps every T3 tool bridge entry within Codex's per-entry cap, in order", () => {
    const command =
      "/nix/store/0000000000000000000000000000000-nodejs-24/bin/node /tmp/t3-tools-0123456789abcdef/t3.mjs";
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      true,
      command,
    );
    for (const [key, entry] of Object.entries(context)) {
      NodeAssert.ok(
        Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
        key,
      );
    }
    const sections = Object.keys(context)
      .filter((key) => key.startsWith("t3_code_orchestration_"))
      .sort()
      .map((key) => context[key]!.value);
    NodeAssert.deepEqual(sections, t3ToolBridgeSections(command));
    NodeAssert.ok(sections.join("\n\n").includes(`${command} --list`));
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
