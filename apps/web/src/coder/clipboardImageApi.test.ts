import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { uploadCoderClipboardImage } from "./api";

class FakeXHR extends EventTarget {
  static instances: FakeXHR[] = [];
  upload = new EventTarget();
  status = 200;
  responseText = JSON.stringify({ path: "/workspace/image.png" });
  timeout = 0;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => {
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("loadend"));
  });
  constructor() {
    super();
    FakeXHR.instances.push(this);
  }
  finish() {
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }
}
const png = () => new File(["image"], "paste.png", { type: "image/png" });
beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());

it("posts original bytes to the loopback workspace route and reports only measured progress", async () => {
  const file = png();
  const progress = vi.fn();
  const result = uploadCoderClipboardImage("workspace one", file, { onProgress: progress });
  const xhr = FakeXHR.instances[0]!;
  expect(xhr.open).toHaveBeenCalledWith(
    "POST",
    "/api/workspaces/workspace%20one/clipboard-image",
    true,
  );
  expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  expect(xhr.send).toHaveBeenCalledWith(file);
  const event = new Event("progress");
  Object.assign(event, { lengthComputable: true, loaded: 3, total: 4 });
  xhr.upload.dispatchEvent(event);
  expect(progress).toHaveBeenLastCalledWith(0.75);
  xhr.upload.dispatchEvent(new Event("load"));
  expect(progress).toHaveBeenLastCalledWith(1);
  let finished = false;
  void result.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  xhr.finish();
  await expect(result).resolves.toBe("/workspace/image.png");
});

it("aborts the HTTP request and releases the abort listener", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const result = uploadCoderClipboardImage("workspace", png(), { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeXHR.instances[0]!.abort).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it.each(["error", "timeout"])(
  "makes %s retryable instead of leaving a pending request",
  async (type) => {
    const result = uploadCoderClipboardImage("workspace", png());
    FakeXHR.instances[0]!.dispatchEvent(new Event(type));
    await expect(result).rejects.toThrow(type === "timeout" ? "timed out" : "failed");
  },
);

it("rejects invalid gateway replies and unsupported files", async () => {
  const result = uploadCoderClipboardImage("workspace", png());
  const xhr = FakeXHR.instances[0]!;
  xhr.responseText = "{}";
  xhr.finish();
  await expect(result).rejects.toThrow("invalid workspace path");
  await expect(
    uploadCoderClipboardImage("workspace", new File(["gif"], "x.gif", { type: "image/gif" })),
  ).rejects.toThrow("PNG, JPEG, or WebP");
  expect(FakeXHR.instances).toHaveLength(1);
});
