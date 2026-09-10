// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MAX_SCREENSHOT_ARTIFACT_BYTES } from "@t3tools/contracts";
import { createImageResourceStore } from "./imageResources";
afterEach(() => vi.restoreAllMocks());
it("bounds concurrent reads and cancels unneeded queued work", async () => {
  const store = createImageResourceStore(undefined, 1);
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Cancelled")));
      }),
  );
  const releaseA = store.subscribe("a", load, () => {});
  const releaseB = store.subscribe("b", load, () => {});
  expect(load).toHaveBeenCalledTimes(1);
  releaseB();
  releaseA();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(load).toHaveBeenCalledTimes(1);
});
it("keeps retained bytes within budget and allows explicit retry after release", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const store = createImageResourceStore(MAX_SCREENSHOT_ARTIFACT_BYTES);
  const blob = new Blob([new Uint8Array(MAX_SCREENSHOT_ARTIFACT_BYTES)]);
  const load = vi.fn(async () => blob);
  const releaseA = store.subscribe("a", load, () => {});
  await vi.waitFor(() => expect(store.get("a").status).toBe("loaded"));
  const releaseB = store.subscribe("b", load, () => {});
  const blocked = store.get("b");
  expect(blocked.status).toBe("error");
  expect(load).toHaveBeenCalledTimes(1);
  releaseA();
  if (blocked.status === "error") blocked.retry();
  await vi.waitFor(() => expect(store.get("b").status).toBe("loaded"));
  releaseB();
  expect(revoke).toHaveBeenCalledTimes(2);
});

it("keeps duplicate subscriptions alive when they share a notification callback", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const store = createImageResourceStore();
  const load = vi.fn(async () => new Blob(["image"]));
  const notify = vi.fn();
  const releaseA = store.subscribe("image", load, notify);
  const releaseB = store.subscribe("image", load, notify);
  await vi.waitFor(() => expect(store.get("image").status).toBe("loaded"));
  releaseA();
  expect(store.get("image").status).toBe("loaded");
  expect(revoke).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
  releaseB();
  expect(revoke).toHaveBeenCalledOnce();
});
