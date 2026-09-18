import { expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { readProjectImageBlob } from "./readProjectImageBlob";
const target = { threadId: ThreadId.make("thread"), cwd: "/project", filePath: "new.png" };
const chunk = {
  dimensions: { width: 64, height: 64 },
  mimeType: "image/png" as const,
  offset: 0,
  totalBytes: 4,
  dataBase64: "AQI=",
  nextOffset: 2,
  revision: "revision",
};
it("continues a file read with the same revision and assembles bounded chunks", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(chunk)
    .mockResolvedValueOnce({ ...chunk, offset: 2, dataBase64: "AwQ=", nextOffset: null });
  const blob = await readProjectImageBlob(target, read, new AbortController().signal);
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  expect(blob.imageDimensions).toEqual({ width: 64, height: 64 });
  expect(read.mock.calls[1]?.[0]).toMatchObject({ ...target, revision: "revision", offset: 2 });
});
it.each([
  { revision: "different" },
  { mimeType: "image/jpeg" },
  { totalBytes: 5 },
  { offset: 1 },
  { dataBase64: "" },
])("rejects inconsistent continuation chunks: %j", async (mutation) => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(chunk)
    .mockResolvedValueOnce({
      ...chunk,
      offset: 2,
      dataBase64: "AwQ=",
      nextOffset: null,
      ...mutation,
    });
  await expect(readProjectImageBlob(target, read, new AbortController().signal)).rejects.toThrow();
});
it("stops fetching when a preview is released", async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => {
    controller.abort();
    return chunk;
  });
  await expect(readProjectImageBlob(target, read, controller.signal)).rejects.toThrow();
  expect(read).toHaveBeenCalledOnce();
});
