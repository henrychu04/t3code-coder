import { expect, it } from "vite-plus/test";
import { messageImageReferences, stripSubmittedImageLinks } from "./submittedImageAttachments";

const legacyPath = "/home/user/.t3-coder/attachments/11111111-1111-4111-8111-111111111111.png";
const pendingPath =
  "/home/user/.t3-coder/attachments/pending-11111111-1111-4111-8111-111111111111-png.png";

it("strips links to generated attachment files from sent prompts", () => {
  expect(stripSubmittedImageLinks(`Describe this\n\n[image](${legacyPath})`)).toBe("Describe this");
  expect(stripSubmittedImageLinks(`Describe this [image](${pendingPath})`)).toBe("Describe this");
});

it("keeps arbitrary paths and external links as written", () => {
  for (const text of [
    "[image](/tmp/picture.png)",
    `[image](https://example.com${legacyPath})`,
    "[image](/home/user/.t3-coder/attachments/not-an-id.png)",
  ]) {
    expect(stripSubmittedImageLinks(text)).toBe(text);
  }
});

it("previews only supported image attachments, by id", () => {
  expect(
    messageImageReferences([
      {
        type: "image",
        id: "thread-1-11111111-1111-4111-8111-111111111111-png",
        name: "Screenshot.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
      { type: "image", id: "legacy-a", name: "image.png", mimeType: "image/png", sizeBytes: 0 },
      { type: "image", id: "gif", name: "a.gif", mimeType: "image/gif", sizeBytes: 3 },
      { type: "file", id: "doc", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 3 },
    ]),
  ).toEqual([
    {
      id: "thread-1-11111111-1111-4111-8111-111111111111-png",
      name: "Screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    },
    { id: "legacy-a", name: "image.png", mimeType: "image/png" },
  ]);
});
