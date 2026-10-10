import { describe, expect, it } from "vite-plus/test";

import {
  T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS,
  t3ToolBridgeInstructions,
} from "./T3ToolInstructions.ts";

describe("T3 tool bridge instructions", () => {
  // Fails when upstream rewords a transport paragraph, so the replacement is revisited.
  it("removes every upstream MCP and ACP transport paragraph", () => {
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).not.toMatch(/MCP|ACP|acp-mcp-call/u);
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).toContain("Use `delegate_task`");
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).toContain("stable `clientRequestId`");
    // Coder: html_preview is not carried.
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).not.toContain("html_preview");
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).toContain("then publish it with `html_render`");
  });

  it("names the thread's exact command", () => {
    const text = t3ToolBridgeInstructions("/nix/node /tmp/t3-tools-x/t3.mjs");
    expect(text).toContain("`/nix/node /tmp/t3-tools-x/t3.mjs --list`");
    expect(text).toContain("task_status");
  });
});
