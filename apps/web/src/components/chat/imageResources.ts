import { MAX_SCREENSHOT_ARTIFACT_BYTES } from "@t3tools/contracts";

export type ImageResourceState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly retry: () => void }
  | { readonly status: "loaded"; readonly url: string; readonly retry: () => void };

const LOADING: ImageResourceState = { status: "loading" };
type Entry = {
  state: ImageResourceState;
  listeners: Set<() => void>;
  load: (signal: AbortSignal) => Promise<Blob>;
  controller: AbortController | undefined;
  bytes: number;
  queued: boolean;
};

/** Shared resource identity follows upstream asset state; Coder owns Blob lifetimes instead of HTTP URLs. */
export function createImageResourceStore(maxBytes = 100 * 1024 * 1024, concurrency = 3) {
  const entries = new Map<string, Entry>();
  let retainedBytes = 0;
  let running = 0;
  const emit = (entry: Entry) => {
    for (const notify of entry.listeners) notify();
  };
  const pump = () => {
    for (const [key, entry] of entries) {
      if (running >= concurrency) break;
      if (!entry.queued) continue;
      entry.queued = false;
      const retry = () => {
        if (entries.get(key) !== entry || entry.state.status === "loading") return;
        if (entry.state.status === "loaded") {
          URL.revokeObjectURL(entry.state.url);
          retainedBytes -= entry.bytes;
          entry.bytes = 0;
        }
        entry.state = LOADING;
        entry.queued = true;
        emit(entry);
        pump();
      };
      // Reserve the maximum permitted image before reading any chunks.
      if (retainedBytes + MAX_SCREENSHOT_ARTIFACT_BYTES > maxBytes) {
        if (running > 0) {
          entry.queued = true;
          break;
        }
        entry.state = { status: "error", retry };
        emit(entry);
        continue;
      }
      entry.bytes = MAX_SCREENSHOT_ARTIFACT_BYTES;
      retainedBytes += entry.bytes;
      running++;
      const controller = new AbortController();
      entry.controller = controller;
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
          if (controller.signal.aborted || entry.state.status !== "loaded") {
            retainedBytes -= entry.bytes;
            entry.bytes = 0;
          }
          if (!controller.signal.aborted) emit(entry);
          pump();
        });
    }
  };
  return {
    get: (key: string): ImageResourceState => entries.get(key)?.state ?? LOADING,
    subscribe(key: string, load: Entry["load"], notify: () => void) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          state: LOADING,
          listeners: new Set(),
          load,
          bytes: 0,
          queued: true,
          controller: undefined,
        };
        entries.set(key, entry);
      }
      // One owner per subscription, even when callers reuse the same callback.
      const listener = () => notify();
      entry.listeners.add(listener);
      pump();
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        entries.delete(key);
        entry.controller?.abort();
        if (entry.state.status === "loaded") {
          URL.revokeObjectURL(entry.state.url);
          retainedBytes -= entry.bytes;
          entry.bytes = 0;
        }
        pump();
      };
    },
  };
}

export const imageResources = createImageResourceStore();
