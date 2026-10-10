import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  extractComposerPastedImageAttachmentIds,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
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

// Coder: staged composer image links.
describe("extractComposerPastedImageAttachmentIds", () => {
  it("extracts and deduplicates staged attachment ids", () => {
    const id = "pending-550e8400-e29b-41d4-a716-446655440000-png";
    expect(
      extractComposerPastedImageAttachmentIds(
        `[image](/home/dev/.t3-coder/attachments/${id}.png) [again](/home/dev/.t3-coder/attachments/${id}.png)`,
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
    const id = "pending-550e8400-e29b-41d4-a716-446655440000-png";
    const attachmentPath = `/home/dev/.t3-coder/attachments/${id}.png`;
    expect(
      extractComposerPastedImageAttachmentIds(
        `[https](https://example.test${attachmentPath}) [host](//example.test${attachmentPath}) [file](file://${attachmentPath})`,
      ),
    ).toEqual([]);
  });
});
