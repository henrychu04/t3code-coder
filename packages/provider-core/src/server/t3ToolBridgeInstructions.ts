/**
 * Coder: how an agent reaches T3 tools over the workspace file bridge. Upstream reaches the
 * same tools as a `t3-code` MCP server; here they run as one shell command per thread. Upstream's
 * sections stay separate so Codex can take each as its own size-limited entry.
 *
 * @module t3ToolBridgeInstructions
 */
import { T3_CODE_ORCHESTRATION_SECTIONS } from "./orchestrationInstructions.ts";

// `html_preview` and the `preview_*` browser are not carried; pages publish with `html_render` alone.
const UPSTREAM_HTML_PREVIEW_STEP = "pass its HTML to `html_preview`, then `html_render`";
const UPSTREAM_PREVIEW_TOOLS = /^- Never use `preview_\*`[^\n]*\n?/mu;

/** Upstream's orchestration sections without the steps that use the uncarried browser tools. */
const T3_BRIDGE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = T3_CODE_ORCHESTRATION_SECTIONS.map(
  (section) =>
    section
      .replace(UPSTREAM_HTML_PREVIEW_STEP, "pass its HTML to `html_render`")
      .replace(UPSTREAM_PREVIEW_TOOLS, "")
      .trimEnd(),
);

export const T3_BRIDGE_ORCHESTRATION_INSTRUCTIONS = T3_BRIDGE_ORCHESTRATION_SECTIONS.join("\n\n");

/** The bridge command's own section followed by the orchestration sections. */
export function t3ToolBridgeSections(command: string): ReadonlyArray<string> {
  return [
    `## T3 tools

T3 Code's app-owned tools for this thread run as a shell command; there is no MCP server. Run \`${command} <tool> '<json params>'\`, or pass \`-\` instead of the JSON to read large parameters from stdin. \`${command} --list\` lists the tools and \`${command} --schema <tool>\` prints a tool's input schema. A call prints its JSON result; a tool's declared failure prints JSON and exits non-zero. A call still running after a few seconds answers \`{"status":"running","taskId":"bridge-job:..."}\`: read its result later with \`${command} task_status '{"taskId":"..."}'\` instead of calling the tool again. This command stays the same for this thread for its whole life; other threads have their own. If a call ever reports the script missing, retry once with this exact command instead of searching \`/tmp\`.`,
    ...T3_BRIDGE_ORCHESTRATION_SECTIONS,
  ];
}

export function t3ToolBridgeInstructions(command: string): string {
  return `

${t3ToolBridgeSections(command).join("\n\n")}
`;
}
