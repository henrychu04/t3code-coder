import { describe, expect, it } from "vite-plus/test";
import { detectImageMimeType } from "./imageSignature.ts";

describe("image signatures", () => {
  it.each([
    ["89504e470d0a1a0a", "image/png"],
    ["ffd8ffe0ffd9", "image/jpeg"],
    ["524946460400000057454250", "image/webp"],
    ["", undefined],
    ["89504e47", undefined],
    ["ffd8ffe00000", undefined],
    ["524946460500000057454250", undefined],
    ["524946460400000057415645", undefined],
  ])("validates %s", (hex, expected) => {
    expect(detectImageMimeType(Buffer.from(hex!, "hex"))).toBe(expected);
  });
});
