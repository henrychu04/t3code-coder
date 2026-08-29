import { describe, expect, it } from "vite-plus/test";

import {
  extractComposerPastedImageAttachmentIds,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("extractComposerPastedImageAttachmentIds", () => {
  it("extracts and deduplicates generated attachment ids", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000.png";
    expect(
      extractComposerPastedImageAttachmentIds(
        `[${id}](/home/dev/.t3-coder/attachments/${id}) [again](/home/dev/.t3-coder/attachments/${id})`,
      ),
    ).toEqual([id]);
  });

  it("rejects arbitrary paths and non-generated names", () => {
    expect(
      extractComposerPastedImageAttachmentIds(
        "[secret](/etc/secret.png) [fake](/home/dev/.t3-coder/attachments/user.png)",
      ),
    ).toEqual([]);
  });

  it("rejects remote links that contain a workspace attachment-shaped path", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000.png";
    const attachmentPath = `/home/dev/.t3-coder/attachments/${id}`;
    expect(
      extractComposerPastedImageAttachmentIds(
        `[https](https://example.test${attachmentPath}) [host](//example.test${attachmentPath}) [file](file://${attachmentPath})`,
      ),
    ).toEqual([]);
  });
});
