import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { uploadCoderClipboardImage } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coder clipboard image API", () => {
  it("posts the clipboard image bytes to the selected workspace", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", {
      type: "image/png",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ path: "/home/user/.t3-coder/attachments/image.png" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadCoderClipboardImage("workspace one", file)).resolves.toBe(
      "/home/user/.t3-coder/attachments/image.png",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace%20one/clipboard-image",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: file,
      }),
    );
  });

  it("rejects unsupported clipboard image formats before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1])], "image.gif", { type: "image/gif" });

    await expect(uploadCoderClipboardImage("workspace", file)).rejects.toThrow(
      "Clipboard image must be PNG, JPEG, or WebP.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
