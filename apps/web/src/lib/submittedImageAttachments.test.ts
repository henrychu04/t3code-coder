import { expect, it } from "vite-plus/test";
import { submittedImageAttachments } from "./submittedImageAttachments";
const path = "/home/user/.t3-coder/attachments/11111111-1111-4111-8111-111111111111.png";
it("reconstructs submitted previews from durable references without a browser cache", () => {
  const result = submittedImageAttachments(`Describe this\n\n[image](${path})`);
  expect(result.text).toBe("Describe this");
  expect(result.images).toEqual([
    { id: "11111111-1111-4111-8111-111111111111", name: "Image 1", mimeType: "image/png" },
  ]);
  expect(submittedImageAttachments(`[a](${path}) [b](${path})`).images).toHaveLength(1);
});
it("does not convert arbitrary paths or external images into read capabilities", () => {
  for (const text of [
    "[image](/tmp/picture.png)",
    `[image](https://example.com${path})`,
    "[image](/home/user/.t3-coder/attachments/not-an-id.png)",
  ]) {
    expect(submittedImageAttachments(text)).toEqual({ text, images: [] });
  }
});
