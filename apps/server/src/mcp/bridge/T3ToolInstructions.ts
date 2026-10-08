/**
 * Coder: how an agent reaches T3 tools over the workspace file bridge. Upstream describes the
 * same tools as a `t3-code` MCP server; here they run as one shell command per thread.
 *
 * @module mcp/bridge/T3ToolInstructions
 */
export function t3ToolBridgeInstructions(command: string): string {
  return `

## T3 tools

T3 Code's app-owned tools for this thread run as a shell command; there is no MCP server. Run \`${command} <tool> '<json params>'\`, or pass \`-\` instead of the JSON to read large parameters from stdin. \`${command} --list\` lists the tools and \`${command} --schema <tool>\` prints a tool's input schema. A call prints its JSON result; a tool's declared failure prints JSON and exits non-zero. A call still running after a few seconds answers \`{"status":"running","taskId":...}\`: read its result later with \`${command} task_status '{"taskId":"..."}'\` instead of calling the tool again. Use this exact command, not one from another thread or an earlier session.
`;
}
