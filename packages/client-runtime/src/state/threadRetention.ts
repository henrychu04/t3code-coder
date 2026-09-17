// Keep recent thread snapshots for back navigation. Live subscriptions end
// when the last detail consumer leaves.
export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

// Match the browser's settled-thread cache limits for the additional resume
// snapshots. Active views own their data; only idle snapshots count here.
const THREAD_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const THREAD_SNAPSHOT_MAX_ENTRIES = 24;

export function makeThreadSnapshotRetention<T>() {
  type Entry = { snapshot: T | undefined };
  const entries = new Map<Entry, number>();
  const encoder = new TextEncoder();
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
    const bytes = encoder.encode(JSON.stringify(entry.snapshot)).byteLength;
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
