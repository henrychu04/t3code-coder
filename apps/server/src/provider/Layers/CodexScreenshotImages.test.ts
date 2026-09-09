import { describe, expect, it } from "@effect/vitest";
import {
  extractCodexScreenshotImages,
  sanitizeCodexScreenshotImages,
} from "./CodexScreenshotImages.ts";

const image = { type: "image", mimeType: "image/png", data: "private-image-bytes" };
const tool = {
  type: "mcpToolCall",
  status: "completed",
  result: { content: [image, { type: "text", text: "Verified layout" }] },
};

describe("Codex screenshot translation", () => {
  it("extracts successful native image results, excluding failures and ordinary image reads", () => {
    expect(extractCodexScreenshotImages({ item: tool })).toEqual([
      { dataBase64: image.data, mimeType: image.mimeType },
    ]);
    expect(extractCodexScreenshotImages({ item: { ...tool, status: "failed" } })).toEqual([]);
    expect(
      extractCodexScreenshotImages({ item: { type: "imageView", path: "/outside/old.png" } }),
    ).toEqual([]);
  });

  it("accepts inline dynamic-tool images without fetching external URLs", () => {
    const item = {
      type: "dynamicToolCall",
      status: "completed",
      success: true,
      contentItems: [
        { type: "inputImage", imageUrl: "data:image/png;base64,private-dynamic-bytes" },
        { type: "inputImage", imageUrl: "https://example.com/image.png" },
      ],
    };
    expect(extractCodexScreenshotImages({ item })).toEqual([
      { dataBase64: "private-dynamic-bytes", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(sanitizeCodexScreenshotImages(item))).not.toContain(
      "private-dynamic-bytes",
    );
  });

  it("recognizes generated image signatures rather than treating arbitrary results as images", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    expect(
      extractCodexScreenshotImages({
        item: { type: "imageGeneration", status: "completed", result: data },
      }),
    ).toEqual([{ dataBase64: data, mimeType: "image/png" }]);
    expect(
      extractCodexScreenshotImages({
        item: { type: "imageGeneration", status: "completed", result: "not an image" },
      }),
    ).toEqual([]);
  });

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
