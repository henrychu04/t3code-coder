import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  extractComposerPastedImageAttachmentIds,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
});

describe("serializeComposerFileLink", () => {
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
