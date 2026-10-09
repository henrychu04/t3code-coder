/**
 * Coder: how an agent reaches T3 tools over the workspace file bridge. Upstream describes the
 * same tools as a `t3-code` MCP server; here they run as one shell command per thread, so only
 * upstream's transport paragraphs change.
 *
 * @module mcp/bridge/T3ToolInstructions
 */
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";

const UPSTREAM_MCP_INTRO = "The `t3-code` MCP server provides app-owned orchestration.";
const UPSTREAM_MCP_TRANSPORT = /\nTool names may include a harness-normalized MCP prefix[^\n]*\n/u;
const UPSTREAM_ACP_FALLBACK = /\nACP fallback:[^\n]*\n/u;

/** Upstream's orchestration guidance without its MCP and ACP transport paragraphs. */
export const T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS = T3_CODE_ORCHESTRATION_INSTRUCTIONS.replace(
  UPSTREAM_MCP_INTRO,
  "T3 tools provide app-owned orchestration.",
)
  .replace(
    UPSTREAM_MCP_TRANSPORT,
    "\nKeep polling/wait loops bounded, do not duplicate active work, and use stable `clientRequestId` values when retrying tools that accept them.\n",
  )
  .replace(UPSTREAM_ACP_FALLBACK, "\n");

export function t3ToolBridgeInstructions(command: string): string {
  return `

## T3 tools

T3 Code's app-owned tools for this thread run as a shell command; there is no MCP server. Run \`${command} <tool> '<json params>'\`, or pass \`-\` instead of the JSON to read large parameters from stdin. \`${command} --list\` lists the tools and \`${command} --schema <tool>\` prints a tool's input schema. A call prints its JSON result; a tool's declared failure prints JSON and exits non-zero. A call still running after a few seconds answers \`{"status":"running","taskId":"bridge-job:..."}\`: read its result later with \`${command} task_status '{"taskId":"..."}'\` instead of calling the tool again. Use this exact command, not one from another thread or an earlier session.
${T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS}`;
}
