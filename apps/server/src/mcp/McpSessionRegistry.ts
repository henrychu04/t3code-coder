/**
 * Upstream's credential registry for provider sessions.
 *
 * Coder: MCP is disabled for both providers and the helper opens no listener, so a credential is
 * a private workspace file bridge (`bridge/FileBridge.ts`) instead of an HTTP bearer token. The
 * registry keeps upstream's lifecycle: the provider session manager issues one credential per
 * thread and session, reuses it across turns, and revokes it when the session is released, the
 * thread is archived or deleted, or the helper stops. Revoking a credential closes its bridge.
 *
 * @module mcp/McpSessionRegistry
 */
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as CoderEnvironment from "../coderEnvironment.ts";
import { createFileBridge, type FileBridge } from "./bridge/FileBridge.ts";
import * as T3ToolDispatch from "./bridge/T3ToolDispatch.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

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
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching a tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

/** Registry credentials always belong to a provider session, so their scope has a thread. */
interface CredentialRecord {
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly bridge: FileBridge | undefined;
  readonly lastAliveAt: number;
}

/** Bounds credentials whose session died without a clean stop, as upstream does. */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Plain paths stay unquoted so the command is also a usable permission-rule prefix. */
const shellWord = (value: string) =>
  /^[A-Za-z0-9@%+=:,./_-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: { readonly livenessWindowMs?: number; readonly bridgeParent?: string } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* CoderEnvironment.CoderEnvironment;
  const tools = yield* T3ToolDispatch.T3ToolDispatch;
  const environmentId = environment.descriptor.environmentId;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  // Keyed by the credential token, the bridge's identity in its config.
  const state = yield* SynchronizedRef.make<ReadonlyMap<string, CredentialRecord>>(new Map());

  const closeAll = (records: Iterable<CredentialRecord>) =>
    Effect.promise(() =>
      Promise.allSettled([...records].map((record) => record.bridge?.close())),
    ).pipe(Effect.asVoid);

  /** Removes matching records, then closes their bridges outside the state lock. */
  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.modify(state, (records) => {
      const removed = [...records.values()].filter(predicate);
      if (removed.length === 0) return [removed, records] as const;
      return [removed, new Map([...records].filter(([, record]) => !predicate(record)))] as const;
    }).pipe(Effect.flatMap(closeAll));

  const pruneDead = (timestamp: number) =>
    revokeWhere((record) => timestamp - record.lastAliveAt > livenessWindowMs);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* Clock.currentTimeMillis;
      yield* pruneDead(issuedAt);
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const token = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        },
        client: undefined,
        // Upstream's scope, so credential reuse sees the capabilities it compares. Preview and
        // device tools are not bridged, so those capabilities grant nothing here.
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          ...(request.capabilities ??
            ((request.browserToolsAvailable ?? true) ? (["preview"] as const) : [])),
        ]),
        issuedAt,
      };
      // Startup binds the toolkits before any provider session opens; until then, no tools.
      const binding = yield* tools.binding;
      const bridge =
        binding === undefined
          ? undefined
          : yield* Effect.tryPromise(() =>
              createFileBridge(
                (call, signal) => Effect.runPromise(tools.dispatch(scope, call), { signal }),
                {
                  catalog: binding.catalog,
                  ...(options.bridgeParent === undefined ? {} : { parent: options.bridgeParent }),
                },
              ),
            ).pipe(
              // Upstream's issue cannot fail; a turn without T3 tools still runs.
              Effect.catch(() =>
                Effect.logWarning("T3 tools unavailable for this session").pipe(
                  Effect.as(undefined),
                ),
              ),
            );
      yield* SynchronizedRef.update(state, (records) =>
        new Map(records).set(token, { scope, bridge, lastAliveAt: issuedAt }),
      );
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint: bridge?.directory ?? "",
          authorizationHeader: `Bearer ${token}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
          ...(bridge === undefined
            ? {}
            : { toolCommand: `${shellWord(process.execPath)} ${shellWord(bridge.script)}` }),
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const timestamp = yield* Clock.currentTimeMillis;
      yield* pruneDead(timestamp);
      return yield* SynchronizedRef.modify(state, (records) => {
        const record = records.get(rawToken);
        if (record === undefined) return [undefined, records] as const;
        return [
          record.scope,
          new Map(records).set(rawToken, { ...record, lastAliveAt: timestamp }),
        ] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* Clock.currentTimeMillis;
      yield* SynchronizedRef.update(
        state,
        (records) =>
          new Map(
            [...records].map(([token, record]) => [
              token,
              record.scope.thread.threadId === threadId ? { ...record, lastAliveAt: timestamp } : record,
            ]),
          ),
      );
    },
  );

  const revokeAll = revokeWhere(() => true);
  yield* Effect.addFinalizer(() => revokeAll);

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: (providerSessionId) =>
      revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId),
    revokeThread: (threadId) => revokeWhere((record) => record.scope.thread.threadId === threadId),
    revokeAll,
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

/**
 * Refreshes the liveness of a thread's credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

/** Exposed for tests. */
export const __testing = { make: makeWithOptions };
