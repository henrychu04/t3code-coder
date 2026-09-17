// Keep recent thread snapshots for back navigation. Live subscriptions end
// when the last detail consumer leaves.
export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

// Match the browser's settled-thread cache limits for the additional resume
// snapshots. Active views own their data; only idle snapshots count here.
const THREAD_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const THREAD_SNAPSHOT_MAX_ENTRIES = 24;

// Do not stringify or UTF-8 encode message bodies during navigation. Six bytes
// per UTF-16 code unit covers JSON's worst-case escaping. Container overhead
// also allows for the small serialization wrappers used by Effect's Options.
// Reject overly complex snapshots instead of doing unbounded work on unmount.
function estimateSnapshotBytes(snapshot: unknown): number {
  let remainingValues = 8_192;
  const visit = (value: unknown, depth: number): number => {
    if (--remainingValues < 0 || depth > 64) return Infinity;
    if (typeof value === "string") return 2 + value.length * 6;
    if (value === null || typeof value !== "object") return 32;
    let bytes = 256;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        bytes += 1 + visit(value[index], depth + 1);
        if (bytes > THREAD_SNAPSHOT_MAX_BYTES) return Infinity;
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += 4 + key.length * 6 + visit((value as Record<string, unknown>)[key], depth + 1);
        if (bytes > THREAD_SNAPSHOT_MAX_BYTES) return Infinity;
      }
    }
    return bytes;
  };
  return visit(snapshot, 0);
}

export function makeThreadSnapshotRetention<T>() {
  type Entry = { snapshot: T | undefined };
  const entries = new Map<Entry, number>();
  let totalBytes = 0;

  const release = (entry: Entry) => {
    const bytes = entries.get(entry);
    if (bytes === undefined) return;
    entries.delete(entry);
    totalBytes -= bytes;
  };

  const retain = (entry: Entry) => {
    release(entry);
    if (entry.snapshot === undefined) return;
    const bytes = estimateSnapshotBytes(entry.snapshot);
    if (bytes > THREAD_SNAPSHOT_MAX_BYTES) {
      entry.snapshot = undefined;
      return;
    }
    while (
      entries.size >= THREAD_SNAPSHOT_MAX_ENTRIES ||
      totalBytes + bytes > THREAD_SNAPSHOT_MAX_BYTES
    ) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      release(oldest);
      oldest.snapshot = undefined;
    }
    entries.set(entry, bytes);
    totalBytes += bytes;
  };

  return { retain, release };
}
