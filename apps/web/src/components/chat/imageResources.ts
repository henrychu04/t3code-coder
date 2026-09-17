import { MAX_SCREENSHOT_ARTIFACT_BYTES } from "@t3tools/contracts";

export type ImageResourceState =
  | { readonly status: "loading" | "deferred" }
  | { readonly status: "error"; readonly retry: () => void }
  | { readonly status: "loaded"; readonly url: string; readonly retry: () => void };

const LOADING: ImageResourceState = { status: "loading" };
const DEFERRED: ImageResourceState = { status: "deferred" };
type Entry = {
  state: ImageResourceState;
  listeners: Map<() => void, boolean>;
  load: (signal: AbortSignal) => Promise<Blob>;
  controller: AbortController | undefined;
  bytes: number;
  queued: boolean;
};

/** Shared URLs, bounded bytes, and priority for the image the user opens. */
export function createImageResourceStore(maxBytes = 100 * 1024 * 1024, concurrency = 3) {
  const entries = new Map<string, Entry>();
  let retainedBytes = 0;
  let running = 0;
  let pumping = false;
  const selected = (entry: Entry) => [...entry.listeners.values()].some(Boolean);
  const emit = (entry: Entry) => {
    for (const notify of entry.listeners.keys()) notify();
  };
  const releaseBytes = (entry: Entry) => {
    if (entry.state.status === "loaded" && entry.bytes > 0) URL.revokeObjectURL(entry.state.url);
    retainedBytes -= entry.bytes;
    entry.bytes = 0;
  };
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      const ordered = [...entries].sort(
        ([, a], [, b]) => Number(selected(b)) - Number(selected(a)),
      );
      for (const [key, entry] of ordered) {
        if (running >= concurrency) break;
        if (!entry.queued || entry.controller) continue;
        const retry = () => {
          if (entries.get(key) !== entry || entry.state.status === "loading") return;
          releaseBytes(entry);
          entry.state = LOADING;
          entry.queued = true;
          emit(entry);
          pump();
        };
        // An opened image may displace full-size previews, but never another
        // opened image or an in-flight read whose reserved bytes are still owned.
        if (selected(entry)) {
          for (const [, candidate] of ordered) {
            if (retainedBytes + MAX_SCREENSHOT_ARTIFACT_BYTES <= maxBytes) break;
            if (candidate === entry || selected(candidate) || candidate.state.status !== "loaded")
              continue;
            releaseBytes(candidate);
            candidate.state = DEFERRED;
            candidate.queued = true;
            emit(candidate);
          }
        }
        if (retainedBytes + MAX_SCREENSHOT_ARTIFACT_BYTES > maxBytes) {
          if (entry.state.status !== "deferred") {
            entry.state = DEFERRED;
            emit(entry);
          }
          continue;
        }
        entry.queued = false;
        entry.state = LOADING;
        entry.bytes = MAX_SCREENSHOT_ARTIFACT_BYTES;
        retainedBytes += entry.bytes;
        running++;
        const controller = new AbortController();
        entry.controller = controller;
        emit(entry);
        void entry
          .load(controller.signal)
          .then((blob) => {
            if (controller.signal.aborted) return;
            if (blob.size === 0 || blob.size > MAX_SCREENSHOT_ARTIFACT_BYTES)
              throw new Error("Invalid image size.");
            const url = URL.createObjectURL(blob);
            retainedBytes -= entry.bytes - blob.size;
            entry.bytes = blob.size;
            entry.state = { status: "loaded", url, retry };
          })
          .catch(() => {
            if (!controller.signal.aborted) entry.state = { status: "error", retry };
          })
          .finally(() => {
            running--;
            entry.controller = undefined;
            if (controller.signal.aborted || entry.state.status !== "loaded") releaseBytes(entry);
            if (!controller.signal.aborted) emit(entry);
            pump();
          });
      }
    } finally {
      pumping = false;
    }
  };
  return {
    get: (key: string): ImageResourceState => entries.get(key)?.state ?? LOADING,
    subscribe(key: string, load: Entry["load"], notify: () => void, priority = false) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          state: LOADING,
          listeners: new Map(),
          load,
          bytes: 0,
          queued: true,
          controller: undefined,
        };
        entries.set(key, entry);
      }
      // Each subscription owns a separate listener and priority claim.
      const listener = () => notify();
      entry.listeners.set(listener, priority);
      pump();
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
          entries.delete(key);
          entry.controller?.abort();
          if (entry.state.status === "loaded") releaseBytes(entry);
        }
        pump();
      };
    },
  };
}

export const imageResources = createImageResourceStore();
