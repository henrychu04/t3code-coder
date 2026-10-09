import { attachmentFileExtension as gatewayAttachmentFileExtension } from "@t3tools/shared/attachmentFileExtension";
import { describe, expect, it } from "vite-plus/test";

import { attachmentFileExtension } from "./attachmentStore.ts";

// Coder: the gateway stages composer files under the extension the helper's claim expects.
describe("composer file extension parity", () => {
  it.each([
    "report.PDF",
    "archive.tar.gz",
    "notes",
    ".bashrc",
    "file.",
    "a..b",
    "..hidden",
    "upload.part",
    "data.toolongextension",
    "image.jp-g",
    "dir/name.txt",
    "space name.md",
    "unicode.é",
  ])("derives the same extension for %s", (name) => {
    expect(gatewayAttachmentFileExtension(name)).toBe(attachmentFileExtension(name));
  });
});
