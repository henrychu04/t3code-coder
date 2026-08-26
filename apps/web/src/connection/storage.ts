import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type {
  EnvironmentId,
  OrchestrationThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";

const noValue = Effect.succeed(Option.none());
const THREAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const THREAD_CACHE_MAX_ENTRIES = 24;
const textEncoder = new TextEncoder();
const threadCache = new Map<
  string,
  {
    readonly environmentId: EnvironmentId;
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly bytes: number;
  }
>();
let threadCacheBytes = 0;

const threadCacheKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\0${threadId}`;

function removeThreadCacheEntry(key: string): void {
  const existing = threadCache.get(key);
  if (!existing) return;
  threadCache.delete(key);
  threadCacheBytes -= existing.bytes;
}

function saveThreadCache(
  environmentId: EnvironmentId,
  snapshot: OrchestrationThreadDetailSnapshot,
): void {
  const key = threadCacheKey(environmentId, snapshot.thread.id);
  removeThreadCacheEntry(key);
  const bytes = textEncoder.encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > THREAD_CACHE_MAX_BYTES) return;
  while (
    threadCache.size > 0 &&
    (threadCache.size >= THREAD_CACHE_MAX_ENTRIES ||
      threadCacheBytes + bytes > THREAD_CACHE_MAX_BYTES)
  ) {
    const oldestKey = threadCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    removeThreadCacheEntry(oldestKey);
  }
  threadCache.set(key, { environmentId, snapshot, bytes });
  threadCacheBytes += bytes;
}

// The browser is a stateless view of the selected Coder workspace. A bounded
// memory-only thread LRU bridges atom eviction and short route gaps; durable
// projects, threads, messages, credentials, and caches stay in that workspace.
export const connectionStorageLayer = Layer.succeedContext(
  Context.make(
    EnvironmentCacheStore,
    EnvironmentCacheStore.of({
      loadShell: () => noValue,
      saveShell: () => Effect.void,
      loadThread: (environmentId, threadId) =>
        Effect.sync(() => {
          const key = threadCacheKey(environmentId, threadId);
          const cached = threadCache.get(key);
          if (!cached) return Option.none<OrchestrationThreadDetailSnapshot>();
          threadCache.delete(key);
          threadCache.set(key, cached);
          return Option.some(cached.snapshot);
        }),
      saveThread: (environmentId, snapshot) =>
        Effect.sync(() => saveThreadCache(environmentId, snapshot)),
      removeThread: (environmentId, threadId) =>
        Effect.sync(() => removeThreadCacheEntry(threadCacheKey(environmentId, threadId))),
      loadServerConfig: () => noValue,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => noValue,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: (environmentId) =>
        Effect.sync(() => {
          for (const [key, cached] of threadCache) {
            if (cached.environmentId === environmentId) removeThreadCacheEntry(key);
          }
        }),
    }),
  ),
);
