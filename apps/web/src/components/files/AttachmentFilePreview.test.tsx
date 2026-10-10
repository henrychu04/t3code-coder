// Coder: draft attachments preview from their in-memory bytes, without a Save action.
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFilePreview } from "./AttachmentFilePreview";

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("draft attachment preview", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("shows a text draft's contents from memory and offers no Save action", async () => {
    const file = new Blob(["hello from a draft\n"], { type: "text/plain" });
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview name="notes.txt" mimeType="text/plain" sizeBytes={19} file={file} />,
      );
    });
    await vi.waitFor(() => {
      expect(renderer!.root.findByType("pre").props.children).toBe("hello from a draft\n");
    });
    const labels = renderer!.root
      .findAllByType("button")
      .map((button) => button.props["aria-label"]);
    expect(labels).not.toContain("Save file");
  });
});
