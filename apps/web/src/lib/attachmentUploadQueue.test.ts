// @vitest-environment happy-dom
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import {
  uploadCoderClipboardImage,
  uploadCoderComposerFile,
  type StagedCoderImage,
} from "../coder/api";
import {
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

const connection = vi.hoisted(() => ({
  phases: new Map<string, string>(),
  listeners: new Map<string, Set<() => void>>(),
  get: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: connection.get,
    subscribe: (id: string, listener: () => void) => {
      const listeners = connection.listeners.get(id) ?? new Set<() => void>();
      connection.listeners.set(id, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: (id: string) => id },
}));
vi.mock("../coder/api", () => ({
  uploadCoderClipboardImage: vi.fn(),
  uploadCoderComposerFile: vi.fn(),
}));
vi.mock("../coder/environmentStore", () => ({
  coderWorkspaceIdForEnvironment: (id: string) => `workspace-${id}`,
}));
vi.mock("../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (id: string) => id },
  useComposerDraftStore: { getState: () => ({}) },
}));

const environmentId = EnvironmentId.make("env-one");
const otherEnvironmentId = EnvironmentId.make("env-two");
let images: Array<ComposerImageAttachment | ComposerFileAttachment>;
let transfers: Array<{
  resolve: (image: StagedCoderImage) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  progress: (value: number) => void;
}>;

function image(): ComposerImageAttachment {
  const file = new File(["pixels"], "image.png", { type: "image/png" });
  const value: ComposerImageAttachment = {
    type: "image",
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: "blob:fixture",
    file,
  };
  images.push(value);
  return value;
}

function setConnection(phase: string): void {
  connection.phases.set(environmentId, phase);
  for (const listener of connection.listeners.get(environmentId) ?? []) listener();
}

function staged(id = "pending-image"): StagedCoderImage {
  return {
    path: `/home/fixture/.t3-coder/attachments/${id}.png`,
    attachment: { id, mimeType: "image/png", sizeBytes: 6 },
  };
}

beforeEach(() => {
  images = [];
  transfers = [];
  connection.phases.clear();
  connection.listeners.clear();
  connection.get.mockImplementation((id: string) =>
    AsyncResult.success({ phase: connection.phases.get(id) ?? "connected" }),
  );
  vi.mocked(uploadCoderClipboardImage).mockImplementation(
    (_workspace, _file, options) =>
      new Promise((resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        transfers.push({ resolve, reject, signal, progress: options!.onProgress! });
      }),
  );
});

afterEach(async () => {
  for (const value of images) releaseAttachmentUpload(value.id);
  await vi.waitFor(() => {
    expect(useAttachmentUploadStore.getState().uploadsByImageId).toEqual({});
    expect([...connection.listeners.values()].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });
  vi.clearAllMocks();
});

it("allows three uploads per environment and advances the queue on completion", async () => {
  const first = Array.from({ length: 4 }, image);
  for (const value of first) startAttachmentUpload({ environmentId, image: value });
  startAttachmentUpload({ environmentId: otherEnvironmentId, image: image() });
  await vi.waitFor(() => expect(transfers).toHaveLength(4));
  expect(vi.mocked(uploadCoderClipboardImage).mock.calls.map((call) => call[0])).toEqual([
    "workspace-env-one",
    "workspace-env-one",
    "workspace-env-one",
    "workspace-env-two",
  ]);
  transfers[0]!.resolve(staged());
  await vi.waitFor(() => expect(transfers).toHaveLength(5));
  expect(readAttachmentUpload(first[0]!.id)?.status).toBe("ready");
});

it("retries a failed upload after reconnect", async () => {
  const value = image();
  startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  setConnection("disconnected");
  transfers[0]!.reject(new Error("Connection lost"));
  await vi.waitFor(() => expect(readAttachmentUpload(value.id)?.status).toBe("failed"));
  setConnection("connected");
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
  transfers[1]!.resolve(staged());
  await vi.waitFor(() => expect(readAttachmentUpload(value.id)?.status).toBe("ready"));
});

it("retries when the HTTP failure arrives after reconnection", async () => {
  const value = image();
  startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  setConnection("disconnected");
  setConnection("connected");
  transfers[0]!.reject(new Error("Late HTTP failure"));
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
});

it("aborts only the removed upload and discards queued work", async () => {
  const values = Array.from({ length: 4 }, image);
  for (const value of values) startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(3));
  releaseAttachmentUpload(values[3]!.id);
  releaseAttachmentUpload(values[0]!.id);
  expect(transfers[0]!.signal.aborted).toBe(true);
  expect(transfers[1]!.signal.aborted).toBe(false);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(transfers).toHaveLength(3);
  expect(readAttachmentUpload(values[0]!.id)).toBeUndefined();
});

it("waits for the workspace copy even after loopback progress reaches 100 percent", async () => {
  const value = image();
  startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  transfers[0]!.progress(1);
  expect(getUploadedAttachments({ environmentId, images: [value] })).toBeNull();
  transfers[0]!.resolve(staged());
  await vi.waitFor(() => expect(readAttachmentUpload(value.id)?.status).toBe("ready"));
  expect(getUploadedAttachments({ environmentId, images: [value] })).toEqual([
    { type: "image", id: "pending-image", name: "image.png", mimeType: "image/png", sizeBytes: 6 },
  ]);
  expect(getUploadedAttachments({ environmentId: otherEnvironmentId, images: [value] })).toBeNull();
});

it("supports explicit retry without replacing the draft image", async () => {
  const value = image();
  startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  transfers[0]!.reject(new Error("Transfer failed"));
  await vi.waitFor(() => expect(readAttachmentUpload(value.id)?.status).toBe("failed"));
  retryAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
  expect(images[0]).toBe(value);
});

it("stages a composer file as-is through the file route", async () => {
  const file = new File(["%PDF-1"], "report.pdf", { type: "application/pdf" });
  const value: ComposerFileAttachment = {
    type: "file",
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
  images.push(value);
  vi.mocked(uploadCoderComposerFile).mockResolvedValue({
    path: "/home/fixture/.t3-coder/attachments/pending-file-pdf.pdf",
    attachment: { id: "pending-file-pdf", sizeBytes: file.size },
  });
  startAttachmentUpload({ environmentId, image: value });
  await vi.waitFor(() =>
    expect(readAttachmentUpload(value.id)).toEqual({
      status: "ready",
      environmentId,
      attachmentId: "pending-file-pdf",
      sizeBytes: file.size,
    }),
  );
  expect(vi.mocked(uploadCoderComposerFile).mock.calls[0]?.[1]).toBe(file);
  expect(uploadCoderClipboardImage).not.toHaveBeenCalled();
});
