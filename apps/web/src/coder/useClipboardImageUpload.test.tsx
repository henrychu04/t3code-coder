// @vitest-environment happy-dom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useClipboardImageUpload } from "./useClipboardImageUpload";
import { uploadCoderClipboardImage } from "./api";
import { coderWorkspaceIdForEnvironment } from "./environmentStore";
vi.mock("./api", () => ({ uploadCoderClipboardImage: vi.fn() }));
vi.mock("./environmentStore", () => ({ coderWorkspaceIdForEnvironment: vi.fn() }));
let root: Root;
let current: ReturnType<typeof useClipboardImageUpload>;
const onError = vi.fn();
function Consumer({ target = "thread:a" }: { target?: string }) {
  current = useClipboardImageUpload(EnvironmentId.make("env"), target, onError);
  return null;
}
const png = () => new File(["image"], "paste.png", { type: "image/png" });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(coderWorkspaceIdForEnvironment).mockReturnValue("workspace");
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Consumer />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("keeps successful paths when a later upload fails", async () => {
  vi.mocked(uploadCoderClipboardImage)
    .mockResolvedValueOnce("attachment-one")
    .mockRejectedValueOnce(new Error("Transfer failed"));
  const publish = vi.fn();
  await act(async () => current.upload([png(), png()], publish));
  expect(publish).toHaveBeenCalledWith(["attachment-one"]);
  expect(onError).toHaveBeenLastCalledWith("Transfer failed");
  expect(current.isUploading).toBe(false);
});
it("retains the originating callback after navigation and rejects duplicate uploads in that draft", async () => {
  let resolve!: (path: string) => void;
  vi.mocked(uploadCoderClipboardImage).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const publish = vi.fn();
  let pending!: Promise<void>;
  await act(async () => {
    pending = current.upload([png()], publish);
  });
  expect(current.isUploading).toBe(true);
  await act(async () => {
    await current.upload([png()], publish);
    root.render(<Consumer target="thread:b" />);
  });
  expect(uploadCoderClipboardImage).toHaveBeenCalledTimes(1);
  expect(current.isUploading).toBe(false);
  await act(async () => {
    resolve("attachment-one");
    await pending;
  });
  expect(publish).toHaveBeenCalledWith(["attachment-one"]);
  expect(onError).not.toHaveBeenCalledWith("Image upload finished after you left the thread.");
});
it("rejects unsupported or oversized files before transferring any bytes", async () => {
  const oversized = png();
  Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
  await act(async () => {
    await current.upload([new File(["gif"], "paste.gif", { type: "image/gif" })], vi.fn());
    await current.upload([oversized], vi.fn());
  });
  expect(uploadCoderClipboardImage).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith("Clipboard image exceeds the 20 MiB limit.");
});

it("allows a new thread to upload while the original thread is still uploading", async () => {
  let finish!: (id: string) => void;
  vi.mocked(uploadCoderClipboardImage)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce("image-b");
  const publishA = vi.fn();
  const publishB = vi.fn();
  let pending!: Promise<void>;
  await act(async () => {
    pending = current.upload([png()], publishA);
  });
  await act(async () => root.render(<Consumer target="thread:b" />));
  expect(current.isUploading).toBe(false);
  await act(async () => current.upload([png()], publishB));
  expect(publishB).toHaveBeenCalledWith(["image-b"]);
  await act(async () => root.render(<Consumer target="thread:a" />));
  expect(current.isUploading).toBe(true);
  await act(async () => {
    finish("image-a");
    await pending;
  });
  expect(publishA).toHaveBeenCalledWith(["image-a"]);
  expect(current.isUploading).toBe(false);
});
