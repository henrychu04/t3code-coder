import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  compressImageToByteLimit,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
} from "./imageCompression";
function makeFile(sizeBytes: number, type = "image/png"): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], "shot.png", { type });
}

function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean; htmlCanvas?: boolean },
) {
  const supportsWebp = options?.supportsWebp ?? true;
  const close = vi.fn();
  const fillRect = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4000, height: 3000, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          fillStyle: "",
          fillRect,
          drawImage: vi.fn(),
        };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const resolvedType = type === "image/webp" && !supportsWebp ? "image/png" : type;
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType });
      }
    },
  );
  if (options?.htmlCanvas) {
    const Canvas = globalThis.OffscreenCanvas;
    class HtmlCanvas extends Canvas {
      toBlob(callback: BlobCallback, type: string, quality: number) {
        void this.convertToBlob({ type, quality }).then(callback);
      }
    }
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("HTMLCanvasElement", HtmlCanvas);
    vi.stubGlobal("document", { createElement: () => new HtmlCanvas(0, 0) });
  }
  return { close, fillRect };
}

afterEach(() => vi.unstubAllGlobals());
describe("main attachment image compression", () => {
  it("compressImageToByteLimit passes small files through byte-for-byte", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const original = makeFile(1024);
    const result = await compressImageToByteLimit(original, 10 * 1024 * 1024);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(false);
    // Pass-through must be the same File object, not a copy.
    expect(result.ok && result.file).toBe(original);
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("compressImageToByteLimit re-encodes an oversized file under the byte cap", async () => {
    stubCanvasPipeline(() => 200_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe("image/webp");
    // The re-encoded name must match the new container format.
    expect(result.ok && result.file.name).toBe("shot.webp");
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
  });

  it("compressImageToByteLimit refuses sources above the decode-safety ceiling", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const result = await compressImageToByteLimit(
      makeFile(MAX_COMPRESSIBLE_SOURCE_BYTES + 1),
      10 * 1024 * 1024,
    );

    expect(result).toEqual({ ok: false, reason: "too-large" });
    // The whole point of the ceiling is to never decode such a file.
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("compressImageToByteLimit reports too-large when no encoding fits", async () => {
    const { close } = stubCanvasPipeline(() => 3_000_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(close).toHaveBeenCalled();
  });

  it("shrinks below the source size when the image is already under MAX_DIMENSION", async () => {
    // A small-but-heavy source (e.g. a dense PNG): only a real downscale can
    // get it under budget, since quality alone is stubbed to never suffice.
    let smallestRequested = Number.POSITIVE_INFINITY;
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 800, height: 600, close })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {
          smallestRequested = Math.min(smallestRequested, width);
        }
        getContext() {
          return { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
        }
        async convertToBlob({ type }: { type: string; quality: number }) {
          // Only a genuinely downscaled pass fits the budget.
          const size = smallestRequested < 800 ? 100_000 : 5_000_000;
          return new Blob([new Uint8Array(size)], { type });
        }
      },
    );

    const result = await compressImageToByteLimit(makeFile(4_000_000), 1_000_000);

    expect(result.ok).toBe(true);
    // Fallback passes must scale off the bitmap, not a fixed 2048 ceiling
    // that would never go below an 800px source.
    expect(smallestRequested).toBeLessThan(800);
  });
});

describe("attachment max edge", () => {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
  const pngHeader = (width: number, height: number) => [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ];
  const jpegHeader = (width: number, height: number) => [
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
  ];
  const image = (header: number[], name: string, type: string) =>
    new File([new Uint8Array([...header, ...new Uint8Array(2048).fill(7)])], name, { type });

  /** Records the decoded size, the canvas sizes, and the encode calls. */
  function stubDecoder(bitmapSize: { width: number; height: number }) {
    const decode = vi.fn(async () => ({ ...bitmapSize, close: vi.fn() }));
    const canvases: Array<{ width: number; height: number }> = [];
    const encodes: Array<{ type: string; quality: number }> = [];
    const fillRect = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(width: number, height: number) {
          canvases.push({ width, height });
        }
        getContext() {
          return { fillRect, drawImage: vi.fn() };
        }
        async convertToBlob(options: { type: string; quality: number }) {
          encodes.push(options);
          return new Blob([new Uint8Array(500_000)], { type: options.type });
        }
      },
    );
    return { decode, canvases, encodes, fillRect };
  }

  it("scales a large PNG screenshot under the byte cap to 2000px and keeps it a PNG", async () => {
    const { decode, canvases, encodes, fillRect } = stubDecoder({ width: 3024, height: 1964 });
    const original = image(pngHeader(3024, 1964), "shot.png", "image/png");

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(decode).toHaveBeenCalledExactlyOnceWith(original, { imageOrientation: "from-image" });
    expect(canvases).toEqual([{ width: 2000, height: 1299 }]);
    expect(encodes.map(({ type }) => type)).toEqual(["image/png"]);
    // PNG keeps alpha, so nothing paints a matte behind it.
    expect(fillRect).not.toHaveBeenCalled();
    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.imageSize).toEqual({ width: 2000, height: 1299 });
    expect(result.ok && result.file.name).toBe("shot.png");
    expect(result.ok && result.file.type).toBe("image/png");
  });

  it("scales a rotated JPEG by its displayed size and keeps it a JPEG", async () => {
    // Stored landscape, displayed portrait after the EXIF rotation.
    const { canvases, encodes } = stubDecoder({ width: 3024, height: 4032 });
    const original = image(jpegHeader(4032, 3024), "photo.jpg", "image/jpeg");

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(canvases).toEqual([{ width: 1500, height: 2000 }]);
    expect(encodes).toEqual([{ type: "image/jpeg", quality: 0.92 }]);
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.imageSize).toEqual({ width: 1500, height: 2000 });
  });

  it.each([
    { label: "a 2000px PNG", header: pngHeader(2000, 1200), type: "image/png" },
    {
      label: "a 3000px GIF",
      header: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xb8, 0x0b, 0x10, 0x04],
      type: "image/gif",
    },
  ])("passes $label through without decoding it", async ({ header, type }) => {
    const { decode } = stubDecoder({ width: 3000, height: 1040 });
    const original = image(header, "image", type);

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(result.ok && result.file).toBe(original);
    expect(result.ok && result.recompressed).toBe(false);
    expect(decode).not.toHaveBeenCalled();
  });
});
