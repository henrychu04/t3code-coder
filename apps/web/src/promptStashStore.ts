import * as Schema from "effect/Schema";
import { create } from "zustand";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v3";
// Remove older image-bearing formats as well as the former text-only stash.
const LEGACY_PROMPT_STASH_STORAGE_KEYS = [
  "t3code:prompt-stash:v1",
  "t3code:prompt-stash:v2",
] as const;

export const MAX_STASH_ENTRIES = 20;

/**
 * A stashed prompt carries only text plus the environment it was written in.
 * Deliberately no model selection — the point of stashing is to move a prompt
 * into a different thread or provider, so restoring must never drag the old
 * model choice along. The environment rides along because pasted images are
 * workspace file links: restoring into a different workspace cannot resolve
 * them, and the composer says so instead of failing silently.
 */
const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  environmentId: Schema.String,
  prompt: Schema.String,
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(StashEntrySchema),
});

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  stashEntry: (entry: PromptStashEntry) => { evicted: PromptStashEntry | null };
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...get().entries];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    set({ entries: nextEntries });
    return { evicted };
  },
  takeEntry: (entryId) => {
    const entry = get().entries.find((candidate) => candidate.id === entryId) ?? null;
    if (entry) set({ entries: get().entries.filter((candidate) => candidate.id !== entryId) });
    return { entry };
  },
}));

// Move an existing text stash into this session before removing browser persistence.
// New stashes, like composer drafts, live only until the page is reloaded.
try {
  const raw = localStorage.getItem(PROMPT_STASH_STORAGE_KEY);
  if (raw) {
    try {
      const entries = decodePersistedPromptStashState(JSON.parse(raw).state).entries;
      usePromptStashStore.setState({ entries: entries.slice(0, MAX_STASH_ENTRIES) });
    } catch {
      /* Ignore invalid legacy data. */
    }
  }
  for (const key of [...LEGACY_PROMPT_STASH_STORAGE_KEYS, PROMPT_STASH_STORAGE_KEY]) {
    localStorage.removeItem(key);
  }
} catch {
  /* Browser storage may be unavailable. */
}
