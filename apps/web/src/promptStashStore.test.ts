import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MAX_STASH_ENTRIES, usePromptStashStore, type PromptStashEntry } from "./promptStashStore";

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

  it("takeEntry removes and returns the entry; second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry("take").entry?.id).toBe("take");
    expect(store.takeEntry("take").entry).toBeNull();
    const entries = usePromptStashStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual(["keep"]);
  });
});

describe("legacy stash cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("recovers existing text for this session and removes every persisted stash", async () => {
    const data = new Map([
      ["t3code:prompt-stash:v1", "legacy"],
      ["t3code:prompt-stash:v2", "legacy"],
      [
        "t3code:prompt-stash:v3",
        JSON.stringify({ state: { entries: [makeEntry({ id: "old" })] } }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      removeItem: (key: string) => data.delete(key),
      setItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
    const { usePromptStashStore: migrated } = await import("./promptStashStore");
    expect(migrated.getState().entries.map((entry) => entry.id)).toEqual(["old"]);
    expect(data.size).toBe(0);
    migrated.getState().stashEntry(makeEntry({ id: "new" }));
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.resetModules();
    const { usePromptStashStore: reloaded } = await import("./promptStashStore");
    expect(reloaded.getState().entries).toEqual([]);
  });
});
