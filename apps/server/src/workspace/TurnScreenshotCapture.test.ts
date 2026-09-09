import { it, expect, vi } from "@effect/vitest";
import { ScreenshotArtifactId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeTurnScreenshotCapture } from "./TurnScreenshotCapture.ts";

const captured = (digest: string) => ({
  digest,
  reference: {
    id: ScreenshotArtifactId.make(digest),
    name: `${digest}.png`,
    mimeType: "image/png" as const,
    sizeBytes: 8,
  },
});

it.effect("deduplicates tool and observed images together and publishes only once", () =>
  Effect.gen(function* () {
    const close = vi.fn(() => ["duplicate", "file"]);
    const capture = yield* makeTurnScreenshotCapture("/project", {
      observeScreenshots: () => Effect.succeed({ close }),
      captureScreenshotBase64: () => Effect.succeed(captured("duplicate")),
      captureScreenshotFile: ({ filePath, cwd, capturedDigests }) => {
        expect(cwd).toBe("/project");
        expect(capturedDigests.has("duplicate")).toBe(true);
        return Effect.succeed(captured(filePath));
      },
    });
    yield* capture.captureImages([{ dataBase64: "bytes", mimeType: "image/png" }]);
    const result = yield* capture.finish;
    expect(result?.artifacts?.map((artifact) => artifact.id)).toEqual(["duplicate", "file"]);
    expect(yield* capture.finish).toBeUndefined();
    capture.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  }),
);

it.effect("shares the ten-image limit across concurrent captures and observed files", () =>
  Effect.gen(function* () {
    const captureFile = vi.fn(() => Effect.succeed(captured("file")));
    const capture = yield* makeTurnScreenshotCapture("/project", {
      observeScreenshots: () => Effect.succeed({ close: () => ["file"] }),
      captureScreenshotBase64: ({ dataBase64 }) => Effect.succeed(captured(dataBase64)),
      captureScreenshotFile: captureFile,
    });
    yield* Effect.forEach(
      Array.from({ length: 20 }, (_, index) => String(index)),
      (dataBase64) => capture.captureImages([{ dataBase64, mimeType: "image/png" }]),
      { concurrency: "unbounded" },
    );
    expect((yield* capture.finish)?.artifacts).toHaveLength(10);
    expect(captureFile).not.toHaveBeenCalled();
  }),
);

it.effect("disposes failed turn observation without accepting late images", () =>
  Effect.gen(function* () {
    const close = vi.fn(() => ["file"]);
    const captureImage = vi.fn(() => Effect.succeed(captured("late")));
    const capture = yield* makeTurnScreenshotCapture("/project", {
      observeScreenshots: () => Effect.succeed({ close }),
      captureScreenshotBase64: captureImage,
    });
    capture.dispose();
    capture.dispose();
    yield* capture.captureImages([{ dataBase64: "bytes", mimeType: "image/png" }]);
    expect(yield* capture.finish).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(captureImage).not.toHaveBeenCalled();
  }),
);
