import { type TerminalAttachInput, type TerminalSummary, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "./terminalSession.ts";

const TERMINAL_BUFFER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TERMINAL_BUFFER_CACHE_MAX_ENTRIES = 128;
const terminalBufferCache = new Map<
  string,
  { readonly state: TerminalBufferState; readonly bytes: number }
>();
let terminalBufferCacheBytes = 0;
const textEncoder = new TextEncoder();

function terminalBufferCacheKey(environmentId: string, input: TerminalAttachInput): string {
  return `${environmentId}\0${input.threadId}\0${input.terminalId}`;
}

function readTerminalBufferCache(key: string): TerminalBufferState {
  const cached = terminalBufferCache.get(key);
  if (!cached) return EMPTY_TERMINAL_BUFFER_STATE;
  terminalBufferCache.delete(key);
  terminalBufferCache.set(key, cached);
  return cached.state;
}

function writeTerminalBufferCache(key: string, state: TerminalBufferState): void {
  const existing = terminalBufferCache.get(key);
  if (existing) {
    terminalBufferCache.delete(key);
    terminalBufferCacheBytes -= existing.bytes;
  }
  const bytes = textEncoder.encode(state.buffer).byteLength;
  while (
    terminalBufferCache.size > 0 &&
    (terminalBufferCache.size >= TERMINAL_BUFFER_CACHE_MAX_ENTRIES ||
      terminalBufferCacheBytes + bytes > TERMINAL_BUFFER_CACHE_MAX_BYTES)
  ) {
    const oldestKey = terminalBufferCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = terminalBufferCache.get(oldestKey);
    terminalBufferCache.delete(oldestKey);
    terminalBufferCacheBytes -= oldest?.bytes ?? 0;
  }
  if (bytes > TERMINAL_BUFFER_CACHE_MAX_BYTES) return;
  terminalBufferCache.set(key, { state, bytes });
  terminalBufferCacheBytes += bytes;
}

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const attach = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:terminal:attach",
    subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>, environmentId) =>
      Stream.suspend(() => {
        const cacheKey = terminalBufferCacheKey(environmentId, input);
        const cached = readTerminalBufferCache(cacheKey);
        return subscribe(WS_METHODS.terminalAttach, {
          ...input,
          ...(cached.sequence === null ? {} : { afterSequence: cached.sequence }),
        }).pipe(
          Stream.scan(cached, applyTerminalAttachStreamEvent),
          Stream.tap((state) =>
            Effect.sync(() => {
              writeTerminalBufferCache(cacheKey, state);
            }),
          ),
        );
      }),
  });
  return {
    attach,
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan([] as ReadonlyArray<TerminalSummary>, applyTerminalMetadataStreamEvent),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
