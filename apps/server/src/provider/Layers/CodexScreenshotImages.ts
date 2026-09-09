import { MAX_SCREENSHOT_ARTIFACT_BYTES } from "@t3tools/contracts";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";
import type { ScreenshotImageInput } from "../../workspace/TurnScreenshotCapture.ts";

const REDACTED = "[image content omitted by T3]";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Native tool results are transient. Only validated artifact references reach activity. */
export function extractCodexScreenshotImages(payload: unknown): ScreenshotImageInput[] {
  const item = record(record(payload)?.item);
  if (!item || item.status !== "completed") return [];
  if (item.type === "imageGeneration" && typeof item.result === "string") {
    if (item.result.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_BYTES / 3) * 4) return [];
    const mimeType = detectImageMimeType(Buffer.from(item.result, "base64"));
    return mimeType ? [{ dataBase64: item.result, mimeType }] : [];
  }
  if (
    item.type === "dynamicToolCall" &&
    item.success === true &&
    Array.isArray(item.contentItems)
  ) {
    return item.contentItems.flatMap((value) => {
      const block = record(value);
      if (block?.type !== "inputImage" || typeof block.imageUrl !== "string") return [];
      const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(block.imageUrl);
      return match
        ? [{ mimeType: match[1]!, dataBase64: block.imageUrl.slice(match[0].length) }]
        : [];
    });
  }
  if (item.type !== "mcpToolCall" || item.error) return [];
  const content = record(item.result)?.content;
  if (!Array.isArray(content)) return [];
  const images: ScreenshotImageInput[] = [];
  for (const value of content) {
    const block = record(value);
    if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push({ dataBase64: block.data, mimeType: block.mimeType });
    }
  }
  return images;
}

/** Strip bytes from raw events, repeated completion payloads, and read/rollback history. */
export function sanitizeCodexScreenshotImages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitizeCodexScreenshotImages) as T;
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      (object.type === "imageGeneration" && key === "result") ||
      (object.type === "inputImage" &&
        key === "imageUrl" &&
        typeof entry === "string" &&
        entry.startsWith("data:")) ||
      (object.type === "image" && (key === "data" || key === "source")) ||
      (object.type === "image" &&
        key === "url" &&
        typeof entry === "string" &&
        entry.startsWith("data:"))
        ? REDACTED
        : sanitizeCodexScreenshotImages(entry),
    ]),
  ) as T;
}
