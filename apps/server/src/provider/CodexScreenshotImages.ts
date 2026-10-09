const REDACTED = "[image content omitted by T3]";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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
