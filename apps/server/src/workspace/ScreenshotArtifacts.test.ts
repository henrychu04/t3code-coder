// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import {
  isScreenshotCandidatePath,
  layer as ScreenshotArtifactsLayer,
  ScreenshotArtifacts,
} from "./ScreenshotArtifacts.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

const makeLayer = (cwd: string, baseDir: string) =>
  ScreenshotArtifactsLayer.pipe(Layer.provide(ServerConfig.ServerConfig.layerTest(cwd, baseDir)));

it.layer(NodeServices.layer)("ScreenshotArtifacts", (it) => {
  it("recognizes supported image candidates without scanning dependency trees", () => {
    expect(isScreenshotCandidatePath("test-results/home.png")).toBe(true);
    expect(isScreenshotCandidatePath("screenshots\\mobile.JPEG")).toBe(true);
    expect(isScreenshotCandidatePath("node_modules/pkg/icon.png")).toBe(false);
    expect(isScreenshotCandidatePath(".git/objects/image.webp")).toBe(false);
    expect(isScreenshotCandidatePath("test-results/report.html")).toBe(false);
  });

  it.effect("captures validated files inside the project and reads bounded chunks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFS.mkdtemp(NodePath.join(process.cwd(), ".screenshot-artifacts-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFS.rm(directory, { force: true, recursive: true })).pipe(
            Effect.orDie,
          ),
      );
      const cwd = NodePath.join(root, "project");
      const baseDir = NodePath.join(root, ".t3-coder");
      yield* Effect.promise(() => NodeFS.mkdir(cwd, { recursive: true }));
      const screenshotPath = NodePath.join(cwd, "result.png");
      yield* Effect.promise(() => NodeFS.writeFile(screenshotPath, ONE_PIXEL_PNG));

      yield* Effect.gen(function* () {
        const artifacts = yield* ScreenshotArtifacts;
        const captured = yield* artifacts.captureFile({ cwd, filePath: screenshotPath });
        expect(captured?.reference).toMatchObject({
          name: "result.png",
          mimeType: "image/png",
          sizeBytes: ONE_PIXEL_PNG.byteLength,
        });

        const first = yield* artifacts.readChunk({
          artifactId: captured!.reference.id,
          offset: 0,
          limit: 16,
        });
        const second = yield* artifacts.readChunk({
          artifactId: captured!.reference.id,
          offset: first.nextOffset!,
          limit: 512 * 1024,
        });
        expect(
          Buffer.concat([
            Buffer.from(first.dataBase64, "base64"),
            Buffer.from(second.dataBase64, "base64"),
          ]),
        ).toEqual(ONE_PIXEL_PNG);
        expect(second.nextOffset).toBeNull();

        const storedPath = NodePath.join(baseDir, "artifacts", `${captured!.reference.id}.png`);
        yield* Effect.promise(async () => {
          await NodeFS.rm(storedPath);
          await NodeFS.symlink(screenshotPath, storedPath);
        });
        const replacedWithSymlink = yield* artifacts
          .readChunk({ artifactId: captured!.reference.id, offset: 0, limit: 16 })
          .pipe(Effect.option);
        expect(Option.isNone(replacedWithSymlink)).toBe(true);
      }).pipe(Effect.provide(makeLayer(cwd, baseDir)));
    }),
  );

  it.effect("rejects paths outside the active project and mismatched image content", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFS.mkdtemp(NodePath.join(process.cwd(), ".screenshot-artifacts-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFS.rm(directory, { force: true, recursive: true })).pipe(
            Effect.orDie,
          ),
      );
      const cwd = NodePath.join(root, "project");
      const baseDir = NodePath.join(root, ".t3-coder");
      yield* Effect.promise(() => NodeFS.mkdir(cwd, { recursive: true }));
      const outside = NodePath.join(root, "outside.png");
      yield* Effect.promise(() => NodeFS.writeFile(outside, ONE_PIXEL_PNG));

      yield* Effect.gen(function* () {
        const artifacts = yield* ScreenshotArtifacts;
        expect(yield* artifacts.captureFile({ cwd, filePath: outside })).toBeUndefined();
        expect(
          yield* artifacts.captureBase64({
            dataBase64: ONE_PIXEL_PNG.toString("base64"),
            mimeType: "image/jpeg",
          }),
        ).toBeUndefined();
        const missing = yield* artifacts
          .readChunk({ artifactId: "not-an-artifact" as never, offset: 0, limit: 16 })
          .pipe(Effect.option);
        expect(Option.isNone(missing)).toBe(true);
      }).pipe(Effect.provide(makeLayer(cwd, baseDir)));
    }),
  );
});
