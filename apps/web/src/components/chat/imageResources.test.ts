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
it("defers previews at the byte budget and resumes automatically after release", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const store = createImageResourceStore(MAX_SCREENSHOT_ARTIFACT_BYTES);
  const blob = new Blob([new Uint8Array(MAX_SCREENSHOT_ARTIFACT_BYTES)]);
  const load = vi.fn(async () => blob);
  const releaseA = store.subscribe("a", load, () => {});
  await vi.waitFor(() => expect(store.get("a").status).toBe("loaded"));
  const releaseB = store.subscribe("b", load, () => {});
  const blocked = store.get("b");
  expect(blocked.status).toBe("deferred");
  expect(load).toHaveBeenCalledTimes(1);
  releaseA();
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

it("lets the selected image displace retained previews without reporting errors or exceeding the budget", async () => {
  const urls = new Set<string>();
  let nextUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:${++nextUrl}`;
    urls.add(url);
    expect(urls.size).toBeLessThanOrEqual(1);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    urls.delete(url);
  });
  const store = createImageResourceStore(MAX_SCREENSHOT_ARTIFACT_BYTES, 1);
  const blob = new Blob([new Uint8Array(MAX_SCREENSHOT_ARTIFACT_BYTES)]);
  const load = vi.fn(async () => blob);
  const releases = Array.from({ length: 8 }, (_, i) => store.subscribe(String(i), load, () => {}));
  await vi.waitFor(() => expect(store.get("0").status).toBe("loaded"));
  expect(store.get("7").status).toBe("deferred");
  let deselect = () => {};
  for (const id of ["7", "3", "0"]) {
    deselect();
    deselect = store.subscribe(id, load, () => {}, true);
    await vi.waitFor(() => expect(store.get(id).status).toBe("loaded"));
    expect(Array.from({ length: 8 }, (_, i) => store.get(String(i)).status)).not.toContain("error");
  }
  deselect();
  releases.forEach((release) => release());
  await vi.waitFor(() => expect(urls.size).toBe(0));
});

it("does not evict an image while a gallery still owns its priority subscription", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:opened");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const store = createImageResourceStore(MAX_SCREENSHOT_ARTIFACT_BYTES, 1);
  const load = async () => new Blob([new Uint8Array(MAX_SCREENSHOT_ARTIFACT_BYTES)]);
  const releaseA = store.subscribe("a", load, () => {}, true);
  await vi.waitFor(() => expect(store.get("a").status).toBe("loaded"));
  const releaseB = store.subscribe("b", load, () => {}, true);
  expect(store.get("b").status).toBe("deferred");
  expect(revoke).not.toHaveBeenCalled();
  releaseA();
  await vi.waitFor(() => expect(store.get("b").status).toBe("loaded"));
  releaseB();
});
