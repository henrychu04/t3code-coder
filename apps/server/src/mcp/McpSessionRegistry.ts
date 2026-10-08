/**
 * Upstream's MCP credential registry for provider sessions.
 *
 * Coder: MCP is disabled for both providers, so no MCP HTTP server exists and no credential is
 * ever issued. The provider session manager runs with `configureMcp: false`; this layer keeps
 * the service contract for the code that still names it. T3 tools may later reach agents through
 * an async workspace file bridge instead of MCP.
 *
 * @module mcp/McpSessionRegistry
 */
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as McpInvocationContext from "./McpInvocationContext.ts";
import type * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

/** Coder: a registry that never issues or resolves a credential. */
export const layer = Layer.succeed(
  McpSessionRegistry,
  McpSessionRegistry.of({
    issue: () => Effect.die(new Error("MCP is disabled in T3 Coder.")),
    resolve: () => Effect.succeed(undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

/** Coder: no credential is ever active. */
export const issueActiveMcpCredential = (
  _request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> => Effect.undefined;

/** Coder: there is no MCP credential liveness to refresh. */
export const touchActiveMcpThread = (_threadId: ThreadId): Effect.Effect<void> => Effect.void;
