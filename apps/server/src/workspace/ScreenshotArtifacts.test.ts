import { createHash } from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { layer as ScreenshotArtifactsLayer, ScreenshotArtifacts } from "./ScreenshotArtifacts.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

const makeLayer = (cwd: string, baseDir: string) =>
  ScreenshotArtifactsLayer.pipe(Layer.provide(ServerConfig.ServerConfig.layerTest(cwd, baseDir)));

it.layer(NodeServices.layer)("ScreenshotArtifacts", (it) => {
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
          dimensions: { width: 1, height: 1 },
        });

        expect(captured!.reference.sourcePathKeys).toEqual([
          createHash("sha256").update(`${captured!.reference.id}\0result.png`).digest("hex"),
        ]);
        expect(JSON.stringify(captured!.reference)).not.toContain(cwd);
        const duplicatePath = NodePath.join(cwd, "other.png");
        yield* Effect.promise(() => NodeFS.writeFile(duplicatePath, ONE_PIXEL_PNG));
        const duplicate = yield* artifacts.captureFile({
          cwd,
          filePath: duplicatePath,
          capturedDigests: new Set([captured!.digest]),
          capturedArtifacts: new Map([[captured!.digest, captured!.reference]]),
        });
        expect(duplicate!.reference.id).toBe(captured!.reference.id);
        expect(duplicate!.reference.sourcePathKeys).toEqual([
          createHash("sha256").update(`${captured!.reference.id}\0other.png`).digest("hex"),
        ]);
        expect(
          (yield* Effect.promise(() => NodeFS.readdir(NodePath.join(baseDir, "artifacts")))).filter(
            (name) => name.endsWith(".png"),
          ),
        ).toHaveLength(1);

        // Tool bytes may differ from the original while still representing its image.
        const transformedBytes = Buffer.concat([ONE_PIXEL_PNG, Buffer.from("re-encoded")]);
        const transformed = yield* artifacts.captureBase64({
          dataBase64: transformedBytes.toString("base64"),
          mimeType: "image/png",
        });
        const linked = yield* artifacts.captureFile({
          cwd,
          filePath: screenshotPath,
          existingOnly: true,
          sourceArtifact: transformed!,
        });
        expect(linked!.reference.id).toBe(transformed!.reference.id);
        expect(linked!.reference.sourcePathKeys).toEqual([
          createHash("sha256").update(`${transformed!.reference.id}\0result.png`).digest("hex"),
        ]);
        const preserved = yield* artifacts.readChunk({
          artifactId: linked!.reference.id,
          offset: 0,
          limit: 512 * 1024,
        });
        expect(Buffer.from(preserved.dataBase64, "base64")).toEqual(transformedBytes);
        yield* Effect.promise(() =>
          NodeFS.writeFile(NodePath.join(root, "outside.png"), ONE_PIXEL_PNG),
        );
        expect(
          yield* artifacts.captureFile({
            cwd,
            filePath: NodePath.join(root, "outside.png"),
            existingOnly: true,
            sourceArtifact: transformed!,
          }),
        ).toBeUndefined();
        const symlinkPath = NodePath.join(cwd, "link.png");
        yield* Effect.promise(() => NodeFS.symlink(screenshotPath, symlinkPath));
        expect(
          yield* artifacts.captureFile({
            cwd,
            filePath: symlinkPath,
            existingOnly: true,
            sourceArtifact: transformed!,
          }),
        ).toBeUndefined();

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

        // The saved version survives changes to the original.
        yield* Effect.promise(() => NodeFS.writeFile(screenshotPath, "changed"));
        expect(
          (yield* artifacts.readChunk({
            artifactId: captured!.reference.id,
            offset: 0,
            limit: 512,
          })).dataBase64,
        ).toBe(ONE_PIXEL_PNG.toString("base64"));
        const attachmentPath = NodePath.join(
          baseDir,
          "attachments",
          `${captured!.reference.id}.png`,
        );
        yield* Effect.promise(async () => {
          await NodeFS.mkdir(NodePath.dirname(attachmentPath), { recursive: true });
          await NodeFS.writeFile(attachmentPath, ONE_PIXEL_PNG);
        });
        const attachment = yield* artifacts.readChunk({
          artifactId: captured!.reference.id,
          source: "attachment",
          offset: 0,
          limit: 512,
        });
        expect(attachment.dataBase64).toBe(ONE_PIXEL_PNG.toString("base64"));
        yield* Effect.promise(async () => {
          await NodeFS.rm(attachmentPath);
          await NodeFS.symlink(screenshotPath, attachmentPath);
        });
        expect(
          Option.isNone(
            yield* artifacts
              .readChunk({
                artifactId: captured!.reference.id,
                source: "attachment",
                offset: 0,
                limit: 512,
              })
              .pipe(Effect.option),
          ),
        ).toBe(true);

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

  it.effect("deduplicates tool and viewed images before writing and enforces the turn limit", () =>
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
      const filePath = NodePath.join(cwd, "result.png");
      yield* Effect.promise(() => NodeFS.writeFile(filePath, ONE_PIXEL_PNG));
      yield* Effect.gen(function* () {
        const artifacts = yield* ScreenshotArtifacts;
        const capturedDigests = new Set<string>();
        const input = {
          dataBase64: ONE_PIXEL_PNG.toString("base64"),
          mimeType: "image/png",
          capturedDigests,
        };
        const first = yield* artifacts.captureBase64(input);
        expect(first).toBeDefined();
        capturedDigests.add(first!.digest);
        for (let index = 0; index < 20; index++) {
          expect(yield* artifacts.captureBase64(input)).toBeUndefined();
          expect(yield* artifacts.captureFile({ cwd, filePath, capturedDigests })).toBeUndefined();
        }
        const artifactDir = NodePath.join(baseDir, "artifacts");
        expect(yield* Effect.promise(() => NodeFS.readdir(artifactDir))).toEqual([
          `${first!.reference.id}.png`,
        ]);
        for (let index = 1; index < 10; index++) {
          const captured = yield* artifacts.captureBase64({
            ...input,
            dataBase64: Buffer.concat([ONE_PIXEL_PNG, Buffer.from([index])]).toString("base64"),
          });
          expect(captured).toBeDefined();
          capturedDigests.add(captured!.digest);
        }
        expect(
          yield* artifacts.captureBase64({
            ...input,
            dataBase64: Buffer.concat([ONE_PIXEL_PNG, Buffer.from([10])]).toString("base64"),
          }),
        ).toBeUndefined();
        expect(yield* Effect.promise(() => NodeFS.readdir(artifactDir))).toHaveLength(10);
        // A new turn owns its own set and can capture the same image again.
        expect(
          yield* artifacts.captureBase64({ ...input, capturedDigests: new Set() }),
        ).toBeDefined();
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
