import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_STASH_ENTRIES,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: { id: string; prompt?: string }): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    environmentId: "env-1",
    prompt: input.prompt ?? `prompt ${input.id}`,
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
}

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("prepends entries so the newest stash is first", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "first" }));
    store.stashEntry(makeEntry({ id: "second" }));
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");
  });

  // This test environment has no `localStorage`, so the store runs on its
  // in-memory fallback — the exact "kept for this session, gone on reload"
  // case the composer must distinguish from an outright write failure.
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry removes and returns the entry; second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry("take").entry?.id).toBe("take");
    expect(store.takeEntry("take").entry).toBeNull();
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("rehydrates a persisted v3 payload", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 3,
        state: { entries: [makeEntry({ id: "persisted", prompt: "hello there" })] },
      }),
    );
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["persisted"]);
    expect(entries[0]?.environmentId).toBe("env-1");
    expect(entries[0]?.prompt).toBe("hello there");
  });

  it("ignores an unreadable legacy payload seeded under the current key", () => {
    // The v1 shape (per-provider queues) does not decode as v3; hydration
    // must fall back to an empty stash rather than throw.
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});
