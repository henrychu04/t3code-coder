// @vitest-environment happy-dom
import {
  EnvironmentId,
  ScreenshotArtifactId,
  type ScreenshotArtifactReference,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useScreenshotArtifacts } from "./useScreenshotArtifacts";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => read }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { readScreenshotArtifact: {} } }));
const artifact: ScreenshotArtifactReference = {
  id: ScreenshotArtifactId.make("artifact"),
  name: "Screenshot",
  mimeType: "image/png",
  sizeBytes: 3,
};
const artifacts = [artifact];
let root: Root;
let images: ReturnType<typeof useScreenshotArtifacts>;
const createUrl = vi.fn();
const revokeUrl = vi.fn();
function Consumer({ expanded = false }: { expanded?: boolean }) {
  images = useScreenshotArtifacts(EnvironmentId.make("env"), artifacts, expanded);
  return null;
}
const chunk = (offset: number, dataBase64: string, nextOffset: number | null) => ({
  _tag: "Success",
  value: {
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    offset,
    dataBase64,
    nextOffset,
    totalBytes: 3,
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createUrl;
      static override revokeObjectURL = revokeUrl;
    },
  );
  createUrl.mockReturnValue("blob:artifact");
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("loads only after expansion, validates multiple chunks, and revokes its URL on unmount", async () => {
  read.mockResolvedValueOnce(chunk(0, "YWI=", 2)).mockResolvedValueOnce(chunk(2, "Yw==", null));
  await act(async () => root.render(<Consumer />));
  expect(read).not.toHaveBeenCalled();
  await act(async () => root.render(<Consumer expanded />));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![0].input.offset).toBe(2);
  expect(images[artifact.id]).toMatchObject({ status: "loaded", url: "blob:artifact" });
  await act(async () => root.render(null));
  expect(revokeUrl).toHaveBeenCalledWith("blob:artifact");
});
it("rejects invalid chunk offsets without exposing an image", async () => {
  read.mockResolvedValue(chunk(1, "YWJj", null));
  await act(async () => root.render(<Consumer expanded />));
  expect(images[artifact.id]).toMatchObject({ status: "error" });
  expect(createUrl).not.toHaveBeenCalled();
});
it("discards a read that completes after its last subscriber unmounts", async () => {
  let resolve!: (value: ReturnType<typeof chunk>) => void;
  read.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => root.render(<Consumer expanded />));
  await act(async () => root.render(null));
  await act(async () => resolve(chunk(0, "YWJj", null)));
  expect(createUrl).not.toHaveBeenCalled();
});

it("loads submitted attachments using returned bounded metadata after reload", async () => {
  const { sizeBytes: _size, ...reference } = artifact;
  function Submitted() {
    images = useScreenshotArtifacts(EnvironmentId.make("env"), [reference], true, "attachment");
    return null;
  }
  read.mockResolvedValue(chunk(0, "YWJj", null));
  await act(async () => root.render(<Submitted />));
  expect(read.mock.calls[0]![0].input.source).toBe("attachment");
  expect(images[artifact.id]).toMatchObject({ status: "loaded", url: "blob:artifact" });
});

it("shares reads and URLs until the last subscriber leaves", async () => {
  read.mockResolvedValue(chunk(0, "YWJj", null));
  await act(async () =>
    root.render(
      <>
        <Consumer expanded />
        <Consumer expanded />
      </>,
    ),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(createUrl).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      <>
        <Consumer expanded />
      </>,
    ),
  );
  expect(revokeUrl).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(revokeUrl).toHaveBeenCalledTimes(1);
});
it("retries a failed shared request explicitly", async () => {
  read.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => root.render(<Consumer expanded />));
  const failed = images[artifact.id];
  expect(failed?.status).toBe("error");
  read.mockResolvedValue(chunk(0, "YWJj", null));
  await act(async () => {
    if (failed?.status === "error") failed.retry();
  });
  expect(images[artifact.id]?.status).toBe("loaded");
  expect(read).toHaveBeenCalledTimes(2);
});
it("isolates identical IDs across workspaces and sources", async () => {
  function Other() {
    useScreenshotArtifacts(EnvironmentId.make("other"), artifacts, true, "attachment");
    return null;
  }
  read.mockResolvedValue(chunk(0, "YWJj", null));
  await act(async () =>
    root.render(
      <>
        <Consumer expanded />
        <Other />
      </>,
    ),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(createUrl).toHaveBeenCalledTimes(2);
});

it("loads previews near the viewport and releases their bytes when they scroll away", async () => {
  const { useImagePreviewVisibility } = await import("./useImagePreviewVisibility");
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  function Preview() {
    const { previewRef, visible } = useImagePreviewVisibility();
    images = useScreenshotArtifacts(EnvironmentId.make("env"), artifacts, visible);
    return <span ref={previewRef} />;
  }
  read.mockResolvedValue(chunk(0, "YWJj", null));
  await act(async () => root.render(<Preview />));
  expect(read).not.toHaveBeenCalled();
  const enter = (isIntersecting: boolean) =>
    act(async () => {
      intersect([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  await enter(true);
  expect(read).toHaveBeenCalledOnce();
  expect(images[artifact.id]?.status).toBe("loaded");
  await enter(false);
  expect(revokeUrl).toHaveBeenCalledWith("blob:artifact");
  await enter(true);
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  expect(disconnect).toHaveBeenCalledOnce();
});

it("reads only the selected gallery image and releases it when navigating", async () => {
  const { CapturedImageDialog } = await import("./CapturedMarkdownImage");
  const second = { ...artifact, id: ScreenshotArtifactId.make("second"), name: "Second" };
  read.mockImplementation(async ({ input }) => ({
    ...chunk(0, "YWJj", null),
    value: { ...chunk(0, "YWJj", null).value, artifactId: input.artifactId },
  }));
  await act(async () =>
    root.render(
      <CapturedImageDialog
        environmentId={EnvironmentId.make("env")}
        onClose={() => {}}
        preview={{
          index: 0,
          images: [artifact, second].map((artifact) => ({
            src: null,
            name: artifact.name,
            artifact,
          })),
        }}
      />,
    ),
  );
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]![0].input.artifactId).toBe(artifact.id);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![0].input.artifactId).toBe(second.id);
  expect(revokeUrl).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("Second");
});
