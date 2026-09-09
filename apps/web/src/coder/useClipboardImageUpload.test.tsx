// @vitest-environment happy-dom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useClipboardImageUpload } from "./useClipboardImageUpload";
import { uploadCoderClipboardImage } from "./api";
import { coderWorkspaceIdForEnvironment } from "./environmentStore";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  pastedImageSendBlockReason,
  appendPastedImagesToPrompt,
} from "../lib/composerPastedImages";
vi.mock("./api", () => ({ uploadCoderClipboardImage: vi.fn() }));
vi.mock("./environmentStore", () => ({
  coderWorkspaceIdForEnvironment: vi.fn(),
  subscribeCoderWorkspaceEnvironments: vi.fn(),
}));
const environmentId = EnvironmentId.make("env");
const a = scopeThreadRef(environmentId, ThreadId.make("a"));
const b = scopeThreadRef(EnvironmentId.make("other-env"), ThreadId.make("b"));
let root: Root;
let current: ReturnType<typeof useClipboardImageUpload>;
const onError = vi.fn();
const png = () => new File(["image"], "paste.png", { type: "image/png" });
const images = (target = a) =>
  useComposerDraftStore.getState().getComposerDraft(target)?.pastedImages ?? [];
let transfers: Array<{
  resolve: (path: string) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  report: (value: number) => void;
}>;
function Consumer({ target = a }) {
  current = useClipboardImageUpload(target.environmentId, target, onError);
  return null;
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  transfers = [];
  vi.mocked(coderWorkspaceIdForEnvironment).mockReturnValue("workspace");
  vi.mocked(uploadCoderClipboardImage).mockImplementation(
    (_workspace, _file, options) =>
      new Promise((resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
        transfers.push({ resolve, reject, signal, report: options!.onProgress! });
      }),
  );
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Consumer />));
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    useComposerDraftStore.getState().clearComposerContent(a);
    useComposerDraftStore.getState().clearComposerContent(b);
  });
  vi.unstubAllGlobals();
});

it("queues repeated pastes, bounds transfers, and leaves typing untouched", async () => {
  await act(async () => {
    current.upload([png(), png()]);
    current.upload([png(), png()]);
    useComposerDraftStore.getState().setPrompt(a, "Text typed during upload");
  });
  expect(images().map((image) => image.status)).toEqual([
    "uploading",
    "uploading",
    "uploading",
    "queued",
  ]);
  expect(transfers).toHaveLength(3);
  await act(async () => transfers[0]!.resolve("/workspace/image-1.png"));
  expect(transfers).toHaveLength(4);
  expect(images().map((image) => image.status)).toEqual([
    "uploaded",
    "uploading",
    "uploading",
    "uploading",
  ]);
  expect(useComposerDraftStore.getState().getComposerDraft(a)?.prompt).toBe(
    "Text typed during upload",
  );
  expect(onError).toHaveBeenLastCalledWith(null);
});

it("shares the workspace limit across drafts", async () => {
  await act(async () => current.upload([png(), png(), png()]));
  await act(async () => root.render(<Consumer target={b} />));
  await act(async () => current.upload([png()]));
  expect(transfers).toHaveLength(3);
  expect(images(b)[0]?.status).toBe("queued");
  await act(async () => transfers[0]!.reject(new Error("Transfer failed")));
  expect(transfers).toHaveLength(4);
  expect(images(b)[0]?.status).toBe("uploading");
});

it("allows three transfers in each workspace without head-of-line blocking", async () => {
  await act(async () => current.upload([png(), png(), png(), png()]));
  await act(async () => root.render(<Consumer target={b} />));
  vi.mocked(coderWorkspaceIdForEnvironment).mockImplementation((id) =>
    id === b.environmentId ? "another-workspace" : "workspace",
  );
  await act(async () => current.upload([png(), png(), png(), png()]));
  expect(transfers).toHaveLength(6);
  expect(images(a)[3]?.status).toBe("queued");
  expect(images(b)[3]?.status).toBe("queued");
  await act(async () => current.remove(images(b)[0]!.id));
  expect(transfers[3]!.signal.aborted).toBe(true);
  expect(transfers).toHaveLength(7);
  expect(images(a)[3]?.status).toBe("queued");
  expect(images(b).every((image) => image.status === "uploading")).toBe(true);
  await act(async () => transfers[0]!.resolve("/workspace/first.png"));
  expect(transfers).toHaveLength(8);
  expect(images(a)[3]?.status).toBe("uploading");
  expect(vi.mocked(uploadCoderClipboardImage).mock.calls.map((call) => call[0])).toEqual([
    "workspace",
    "workspace",
    "workspace",
    "another-workspace",
    "another-workspace",
    "another-workspace",
    "another-workspace",
    "workspace",
  ]);
});

it("retains failed images for retry and blocks sending until all images are ready", async () => {
  await act(async () => current.upload([png(), png()]));
  const failedId = images()[1]!.id;
  await act(async () => {
    transfers[0]!.resolve("/workspace/one.png");
    transfers[1]!.reject(new Error("Transfer failed"));
  });
  expect(images().map((image) => image.status)).toEqual(["uploaded", "failed"]);
  expect(pastedImageSendBlockReason(images())).toContain("Retry or remove");
  expect(() => appendPastedImagesToPrompt("test", images())).toThrow("Retry or remove");
  await act(async () => current.retry(failedId));
  expect(images()[1]!.id).toBe(failedId);
  expect(images()[1]!.status).toBe("uploading");
  await act(async () => transfers[2]!.resolve("/workspace/two.png"));
  expect(pastedImageSendBlockReason(images())).toBeNull();
});

it("removes queued work without transferring it and aborts only the removed active upload", async () => {
  await act(async () => current.upload([png(), png(), png(), png()]));
  const [first, second, third, queued] = images();
  await act(async () => {
    current.remove(queued!.id);
    current.remove(first!.id);
  });
  expect(transfers).toHaveLength(3);
  expect(transfers[0]!.signal.aborted).toBe(true);
  expect(transfers[1]!.signal.aborted).toBe(false);
  expect(images().map((image) => image.id)).toEqual([second!.id, third!.id]);
  await act(async () => transfers[0]!.resolve("/late-result.png"));
  expect(images()).toHaveLength(2);
});

it("keeps the originating draft and workspace when navigating or unmounting", async () => {
  await act(async () => current.upload([png()]));
  await act(async () => root.render(<Consumer target={b} />));
  vi.mocked(coderWorkspaceIdForEnvironment).mockImplementation((id) =>
    id === b.environmentId ? "another-workspace" : "workspace",
  );
  await act(async () => current.upload([png()]));
  await act(async () => root.render(null));
  await act(async () => {
    transfers[0]!.resolve("/original/image.png");
    transfers[1]!.resolve("/other/image.png");
  });
  expect(images(a)[0]).toMatchObject({ status: "uploaded", path: "/original/image.png" });
  expect(images(b)[0]).toMatchObject({ status: "uploaded", path: "/other/image.png" });
  expect(vi.mocked(uploadCoderClipboardImage).mock.calls.map((call) => call[0])).toEqual([
    "workspace",
    "another-workspace",
  ]);
});

it("tracks byte progress without marking the workspace copy ready", async () => {
  await act(async () => current.upload([png()]));
  await act(async () => transfers[0]!.report(1));
  expect(images()[0]).toMatchObject({ status: "uploading", progress: 1 });
  expect(pastedImageSendBlockReason(images())).not.toBeNull();
  await act(async () => transfers[0]!.resolve("/image.png"));
  expect(pastedImageSendBlockReason(images())).toBeNull();
});

it("limits progress updates to upstream's five-percent steps", async () => {
  await act(async () => current.upload([png()]));
  await act(async () => transfers[0]!.report(0.11));
  const before = images()[0];
  await act(async () => transfers[0]!.report(0.14));
  expect(images()[0]).toBe(before);
  await act(async () => transfers[0]!.report(0.16));
  expect(images()[0]).toMatchObject({ status: "uploading", progress: 0.16 });
  await act(async () => transfers[0]!.report(1));
  expect(images()[0]).toMatchObject({ status: "uploading", progress: 1 });
  expect(pastedImageSendBlockReason(images())).not.toBeNull();
});

it("enforces the attachment limit including queued and failed images", async () => {
  await act(async () => current.upload(Array.from({ length: 8 }, png)));
  await act(async () => current.upload([png()]));
  expect(images()).toHaveLength(8);
  expect(onError).toHaveBeenLastCalledWith("You can attach up to 8 pasted images per message.");
});

it("rejects unsupported and oversized images before enqueueing", async () => {
  const oversized = png();
  Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
  await act(async () => {
    current.upload([new File(["gif"], "paste.gif", { type: "image/gif" })]);
    current.upload([oversized]);
  });
  expect(transfers).toHaveLength(0);
  expect(images()).toHaveLength(0);
  expect(onError).toHaveBeenLastCalledWith("Clipboard image exceeds the 20 MiB limit.");
});

it.each(["uploading", "uploaded", "failed"] as const)(
  "re-uploads a %s image when its draft moves to another workspace",
  async (status) => {
    vi.mocked(coderWorkspaceIdForEnvironment).mockImplementation((id) =>
      id === b.environmentId ? "another-workspace" : "workspace",
    );
    await act(async () => current.upload([png()]));
    const original = images(a)[0]!;
    if (status === "uploaded") {
      await act(async () => transfers[0]!.resolve("/original/image.png"));
    } else if (status === "failed") {
      await act(async () => transfers[0]!.reject(new Error("Failed in original workspace")));
    }
    await act(async () => useComposerDraftStore.getState().moveComposerPrompt(a, b));
    expect(images(a)).toHaveLength(0);
    expect(images(b)[0]).toMatchObject({ status: "uploading", workspaceId: "another-workspace" });
    expect(images(b)[0]!.id).not.toBe(original.id);
    expect(images(b)[0]!.file).toBe(original.file);
    expect(pastedImageSendBlockReason(images(b))).not.toBeNull();
    expect(transfers).toHaveLength(2);
    if (status === "uploading") {
      expect(transfers[0]!.signal.aborted).toBe(true);
      await act(async () => transfers[0]!.resolve("/late-original/image.png"));
      expect(images(b)[0]!.status).toBe("uploading");
    }
    await act(async () => transfers[1]!.resolve("/destination/image.png"));
    expect(images(b)[0]).toMatchObject({
      status: "uploaded",
      workspaceId: "another-workspace",
      path: "/destination/image.png",
    });
    expect(pastedImageSendBlockReason(images(b))).toBeNull();
  },
);

it("keeps an in-flight upload when moving between drafts in the same workspace", async () => {
  await act(async () => current.upload([png()]));
  const id = images(a)[0]!.id;
  await act(async () => useComposerDraftStore.getState().moveComposerPrompt(a, b));
  expect(transfers).toHaveLength(1);
  expect(transfers[0]!.signal.aborted).toBe(false);
  await act(async () => transfers[0]!.resolve("/original/image.png"));
  expect(images(b)[0]).toMatchObject({ id, status: "uploaded", workspaceId: "workspace" });
});

it("re-uploads original bytes when a completed attachment is restored into another workspace", async () => {
  vi.mocked(coderWorkspaceIdForEnvironment).mockImplementation((id) =>
    id === b.environmentId ? "another-workspace" : "workspace",
  );
  await act(async () => current.upload([png()]));
  await act(async () => transfers[0]!.resolve("/original/image.png"));
  const stashedImages = images(a);
  await act(async () => useComposerDraftStore.getState().clearComposerContent(a));
  await act(async () => useComposerDraftStore.getState().setPastedImages(b, stashedImages));
  expect(images(b)[0]).toMatchObject({ status: "uploading", workspaceId: "another-workspace" });
  expect(images(b)[0]!.file).toBe(stashedImages[0]!.file);
  await act(async () => transfers[1]!.resolve("/destination/image.png"));
  expect(appendPastedImagesToPrompt("", images(b))).toContain("/destination/image.png");
  expect(appendPastedImagesToPrompt("", images(b))).not.toContain("/original/image.png");
});
