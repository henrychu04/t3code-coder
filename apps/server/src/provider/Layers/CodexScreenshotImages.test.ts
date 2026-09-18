import { describe, expect, it } from "@effect/vitest";
import {
  sanitizeCodexScreenshotImages,
} from "./CodexScreenshotImages.ts";

const image = { type: "image", mimeType: "image/png", data: "private-image-bytes" };
const tool = {
  type: "mcpToolCall",
  status: "completed",
  result: { content: [image, { type: "text", text: "Verified layout" }] },
};

describe("Codex screenshot translation", () => {
  it("redacts repeated image bytes in history and raw payloads while preserving text and the original input", () => {
    const history = {
      turns: [
        {
          items: [
            tool,
            { type: "imageGeneration", result: "private-generated-bytes" },
            { type: "image", url: "data:image/png;base64,private-input-bytes" },
          ],
        },
      ],
    };
    const sanitized = sanitizeCodexScreenshotImages(history);
    expect(JSON.stringify(sanitized)).not.toContain("private-");
    expect(JSON.stringify(sanitized)).toContain("Verified layout");
    expect(JSON.stringify(history)).toContain("private-image-bytes");
  });
});
