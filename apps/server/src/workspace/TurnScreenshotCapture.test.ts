import { createHash } from "node:crypto";
import { it, expect, vi } from "@effect/vitest";
import { ScreenshotArtifactId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { CapturedScreenshotArtifact } from "./ScreenshotArtifacts.ts";
import { makeTurnScreenshotCapture } from "./TurnScreenshotCapture.ts";

const captured = (bytes: string) => ({
  digest: createHash("sha256").update(Buffer.from(bytes, "base64")).digest("hex"),
  reference: {
    id: ScreenshotArtifactId.make(bytes),
    name: "image.png",
    mimeType: "image/png" as const,
    sizeBytes: 8,
  },
});
const image = { dataBase64: "YWJj", mimeType: "image/png" };
it.effect("returns images on the viewing event and reuses their immutable copy", () =>
  Effect.gen(function* () {
    const save = vi.fn(({ dataBase64 }: { dataBase64: string }) =>
      Effect.succeed(captured(dataBase64)),
    );
    const capture = yield* makeTurnScreenshotCapture("/project", { captureScreenshotBase64: save });
    const first = yield* capture.captureImages([image]);
    const again = yield* capture.captureImages([image]);
    expect(first.artifacts).toHaveLength(1);
    expect(again).toEqual(first);
    expect(save).toHaveBeenCalledTimes(1);
    expect(yield* capture.finish).toBeUndefined();
  }),
);
it.effect("captures existing files immediately rather than waiting for turn completion", () =>
  Effect.gen(function* () {
    const save = vi.fn(() => Effect.succeed(captured("YWJj")));
    const capture = yield* makeTurnScreenshotCapture("/project", { captureScreenshotFile: save });
    const result = yield* capture.captureImages([], "/project/existing.png");
    expect(result.artifacts).toHaveLength(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/project", filePath: "/project/existing.png" }),
    );
    yield* capture.finish;
    expect(save).toHaveBeenCalledTimes(1);
  }),
);
it.effect("shares the cap across events and reports omissions while allowing duplicates", () =>
  Effect.gen(function* () {
    const capture = yield* makeTurnScreenshotCapture("/project", {
      captureScreenshotBase64: ({ dataBase64 }) => Effect.succeed(captured(dataBase64)),
    });
    const results = yield* Effect.forEach(
      Array.from({ length: 12 }, (_, i) => Buffer.from(String(i)).toString("base64")),
      (dataBase64) => capture.captureImages([{ dataBase64, mimeType: "image/png" }]),
      { concurrency: "unbounded" },
    );
    expect(results.flatMap((result) => result.artifacts)).toHaveLength(10);
    expect(results.filter((result) => result.imageCaptureWarning)).toHaveLength(2);
    expect(
      (yield* capture.captureImages([{ dataBase64: "MA==", mimeType: "image/png" }])).artifacts,
    ).toHaveLength(1);
  }),
);
it.effect("reports unavailable images and refuses late capture after disposal", () =>
  Effect.gen(function* () {
    const save = vi.fn(() => Effect.succeed(undefined));
    const capture = yield* makeTurnScreenshotCapture("/project", { captureScreenshotFile: save });
    expect((yield* capture.captureImages([], "/outside/image.png")).imageCaptureWarning).toBe(
      "Image could not be preserved.",
    );
    capture.dispose();
    expect((yield* capture.captureImages([], "/project/image.png")).artifacts).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  }),
);

it.effect(
  "keeps path observations out of the shared byte cache and links transformed tool bytes",
  () =>
    Effect.gen(function* () {
      const save = vi.fn(
        ({
          sourceArtifact,
          capturedArtifacts,
        }: {
          sourceArtifact?: CapturedScreenshotArtifact;
          capturedArtifacts?: ReadonlyMap<string, unknown>;
        }) => {
          if (sourceArtifact) {
            expect(sourceArtifact.reference.sourcePathKeys).toBeUndefined();
            return Effect.succeed({
              ...sourceArtifact,
              reference: { ...sourceArtifact.reference, sourcePathKeys: ["current-path"] },
            });
          }
          expect([...capturedArtifacts!.values()]).toEqual([]);
          return Effect.succeed({
            ...captured("YWJj"),
            reference: { ...captured("YWJj").reference, sourcePathKeys: ["old-path"] },
          });
        },
      );
      const capture = yield* makeTurnScreenshotCapture("/project", { captureScreenshotFile: save });
      const first = yield* capture.captureImages([], "/project/a.png");
      expect(first.artifacts[0]!.sourcePathKeys).toEqual(["old-path"]);
      const plain = yield* capture.captureImages([image]);
      expect(plain.artifacts[0]!.sourcePathKeys).toBeUndefined();
      const linked = yield* capture.captureImages([image], "/project/b.png");
      expect(linked.artifacts[0]!.sourcePathKeys).toEqual(["current-path"]);
      expect(first.artifacts[0]!.sourcePathKeys).toEqual(["old-path"]);
    }),
);
