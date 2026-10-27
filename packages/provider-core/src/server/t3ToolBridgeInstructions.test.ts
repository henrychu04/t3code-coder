import { describe, expect, it } from "vite-plus/test";

import {
  T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS,
  t3ToolBridgeInstructions,
} from "./t3ToolBridgeInstructions.ts";

describe("T3 tool bridge instructions", () => {
  // Fails when upstream rewords a transport or browser step, so the replacement is revisited.
  it("removes every upstream MCP, ACP, and browser preview step", () => {
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).not.toMatch(/MCP|ACP|acp-mcp-call/u);
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).toContain("Use `delegate_task`");
    // Coder: html_preview and the preview browser are not carried.
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).not.toMatch(/html_preview|preview_/u);
    expect(T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS).toContain("pass its HTML to `html_render`");
  });

  it("names the thread's exact command", () => {
    const text = t3ToolBridgeInstructions("/nix/node /tmp/t3-tools-x/t3.mjs");
    expect(text).toContain("`/nix/node /tmp/t3-tools-x/t3.mjs --list`");
    expect(text).toContain("task_status");
    expect(text).toContain("stays the same for this thread for its whole life");
    expect(text).toContain("retry once with this exact command instead of searching `/tmp`");
    expect(text).not.toContain("an earlier session");
  });
});
