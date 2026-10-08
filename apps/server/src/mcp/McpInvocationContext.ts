/**
 * Coder: MCP is disabled, so only upstream's capability and scope types remain. The invocation
 * context service and its capability guards belong to the omitted MCP HTTP server.
 *
 * @module mcp/McpInvocationContext
 */
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}
