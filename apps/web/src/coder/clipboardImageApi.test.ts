import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { uploadCoderClipboardImage, uploadCoderComposerFile } from "./api";

const STAGED = {
  path: "/workspace/pending-11111111-1111-4111-8111-111111111111-png.png",
  attachment: {
    id: "pending-11111111-1111-4111-8111-111111111111-png",
    mimeType: "image/png",
    sizeBytes: 5,
  },
};

class FakeXHR extends EventTarget {
  static instances: FakeXHR[] = [];
  upload = new EventTarget();
  status = 200;
  responseText = JSON.stringify(STAGED);
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
  await expect(result).resolves.toEqual(STAGED);
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

it("rejects prepared uploads above main's 10 MiB cap before sending bytes", async () => {
  const image = png();
  Object.defineProperty(image, "size", { value: 10 * 1024 * 1024 + 1 });
  await expect(uploadCoderClipboardImage("workspace", image)).rejects.toThrow("10 MiB");
  expect(FakeXHR.instances).toHaveLength(0);
});

it("stages composer files through the file route with the name only in the query", async () => {
  const file = new File(["%PDF-1"], "Q3 report.pdf", { type: "" });
  const result = uploadCoderComposerFile("workspace", file);
  const xhr = FakeXHR.instances[0]!;
  expect(xhr.open).toHaveBeenCalledWith(
    "POST",
    "/api/workspaces/workspace/attachment-file?name=Q3%20report.pdf",
    true,
  );
  expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");
  const staged = {
    path: "/workspace/pending-11111111-1111-4111-8111-111111111111-pdf.pdf",
    attachment: { id: "pending-11111111-1111-4111-8111-111111111111-pdf", sizeBytes: 6 },
  };
  xhr.responseText = JSON.stringify(staged);
  xhr.finish();
  await expect(result).resolves.toEqual(staged);
});

it("rejects composer files above 50 MiB and replies for another size", async () => {
  const big = new File(["x"], "big.bin");
  Object.defineProperty(big, "size", { value: 50 * 1024 * 1024 + 1 });
  await expect(uploadCoderComposerFile("workspace", big)).rejects.toThrow("50 MiB");
  expect(FakeXHR.instances).toHaveLength(0);

  const result = uploadCoderComposerFile("workspace", new File(["abc"], "a.txt"));
  const xhr = FakeXHR.instances[0]!;
  xhr.responseText = JSON.stringify({
    path: "/workspace/pending-11111111-1111-4111-8111-111111111111-txt.txt",
    attachment: { id: "pending-11111111-1111-4111-8111-111111111111-txt", sizeBytes: 99 },
  });
  xhr.finish();
  await expect(result).rejects.toThrow("invalid workspace path");
});
