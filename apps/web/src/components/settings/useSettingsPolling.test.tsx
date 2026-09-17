// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useSettingsPolling } from "./useSettingsPolling";
let root: Root;
let host: HTMLDivElement;
let poll: ReturnType<typeof useSettingsPolling<string>>;
function Probe({
  load,
  identity = "one",
  enabled = true,
}: {
  load: (signal: AbortSignal) => Promise<string>;
  identity?: string;
  enabled?: boolean;
}) {
  poll = useSettingsPolling({ load, identity, intervalMs: 2000, enabled });
  return null;
}
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("waits for a read to finish before scheduling the next poll", async () => {
  const first = deferred();
  const load = vi.fn(() => first.promise);
  await act(async () => root.render(<Probe load={load} />));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve("ready"));
  expect(poll.data).toBe("ready");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(load).toHaveBeenCalledTimes(2);
});
it("aborts superseded reads and ignores late results after changing identity", async () => {
  const first = deferred();
  const second = deferred();
  const signals: AbortSignal[] = [];
  const load = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : second.promise;
  });
  await act(async () => root.render(<Probe load={load} />));
  await act(async () => root.render(<Probe load={load} identity="two" />));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => second.resolve("new"));
  await act(async () => first.resolve("old"));
  expect(poll.data).toBe("new");
  await act(async () => root.unmount());
  expect(signals[1]?.aborted).toBe(true);
  root = createRoot(host);
});
it("pauses scheduled polling while hidden and refreshes when visible again", async () => {
  const load = vi.fn(async () => "ready");
  await act(async () => root.render(<Probe load={load} />));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(load).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(load).toHaveBeenCalledTimes(2);
});
it("exposes refresh failures and clears them on an explicit retry", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ready");
  await act(async () => root.render(<Probe load={load} />));
  expect(poll.error).toBe("offline");
  await act(async () => poll.refresh());
  expect(poll.error).toBeNull();
  expect(poll.data).toBe("ready");
});
it("does not poll empty resource lists", async () => {
  const load = vi.fn(async () => "ready");
  await act(async () => root.render(<Probe load={load} enabled={false} />));
  await act(async () => poll.refresh());
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(load).not.toHaveBeenCalled();
});
