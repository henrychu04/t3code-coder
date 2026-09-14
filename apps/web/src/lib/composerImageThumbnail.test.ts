import { afterEach, expect, it, vi } from "vite-plus/test";
import { createComposerImageThumbnail } from "./composerImageThumbnail";

afterEach(() => vi.unstubAllGlobals());
it("caches a bounded center crop while retaining the original file", async () => {
  const original = new File(["original"], "paste.png", { type: "image/png" });
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 4000, height: 2000, close }));
  const drawImage = vi.fn();
  const thumbnail = new Blob(["small"], { type: "image/png" });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (done: (blob: Blob) => void) => done(thumbnail),
  };
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("document", { createElement: () => canvas });
  const first = createComposerImageThumbnail(original);
  expect(createComposerImageThumbnail(original)).toBe(first);
  expect(await first).toBe(thumbnail);
  expect(canvas.width).toBe(256);
  expect(canvas.height).toBe(256);
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 1000, 0, 2000, 2000, 0, 0, 256, 256);
  expect(close).toHaveBeenCalledOnce();
  expect(await original.text()).toBe("original");
});
it("closes decoded images when a preview cannot be rendered", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 20, height: 10, close }));
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
  expect(await createComposerImageThumbnail(new File(["original"], "paste.png"))).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});
