// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ScreenshotArtifactId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { layer, ScreenshotArtifacts } from "./ScreenshotArtifacts.ts";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
it.layer(NodeServices.layer)("Legacy images", (it) => {
  it.effect(
    "reads existing captures and submitted attachments but rejects symlinks and invalid IDs",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), ".legacy-images-"))),
          (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
        );
        const id = ScreenshotArtifactId.make("550e8400-e29b-41d4-a716-446655440000");
        yield* Effect.gen(function* () {
          const images = yield* ScreenshotArtifacts;
          for (const source of ["artifact", "attachment"] as const) {
            const file = path.join(
              root,
              source === "artifact" ? "artifacts" : "attachments",
              `${id}.png`,
            );
            yield* Effect.promise(async () => {
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, png);
            });
            const chunk = yield* images.readChunk({
              artifactId: id,
              source,
              offset: 0,
              limit: 512,
            });
            expect(Buffer.from(chunk.dataBase64, "base64")).toEqual(png);
            yield* Effect.promise(async () => {
              await fs.rm(file);
              await fs.symlink(path.join(root, "outside.png"), file);
            });
            expect(
              (yield* images
                .readChunk({ artifactId: id, source, offset: 0, limit: 512 })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
          }
          const attachmentsDir = path.join(root, "attachments");
          for (const [artifactId, file] of [
            [
              "thread-1-550e8400-e29b-41d4-a716-446655440001-png",
              "thread-1-550e8400-e29b-41d4-a716-446655440001-png.png",
            ],
            [
              "legacy-550e8400-e29b-41d4-a716-446655440002-png",
              "550e8400-e29b-41d4-a716-446655440002.png",
            ],
          ] as const) {
            yield* Effect.promise(() => fs.writeFile(path.join(attachmentsDir, file), png));
            const chunk = yield* images.readChunk({
              artifactId: ScreenshotArtifactId.make(artifactId),
              source: "attachment",
              offset: 0,
              limit: 512,
            });
            expect(chunk.mimeType).toBe("image/png");
            expect(Buffer.from(chunk.dataBase64, "base64")).toEqual(png);
          }
          expect(
            (yield* images
              .readChunk({
                artifactId: ScreenshotArtifactId.make("../outside"),
                source: "attachment",
                offset: 0,
                limit: 512,
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* images
              .readChunk({
                artifactId: ScreenshotArtifactId.make("../outside"),
                offset: 0,
                limit: 512,
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(layer.pipe(Layer.provide(ServerConfig.layerTest(root, root)))));
      }),
  );

  it.effect("reads a sent file attachment of any type in bounded chunks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), ".attachment-files-"))),
        (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
      );
      yield* Effect.gen(function* () {
        const images = yield* ScreenshotArtifacts;
        const attachmentsDir = path.join(root, "attachments");
        const id = ScreenshotArtifactId.make("thread-1-550e8400-e29b-41d4-a716-446655440003-pdf");
        const bytes = Buffer.from("%PDF-1.7 not an image");
        yield* Effect.promise(async () => {
          await fs.mkdir(attachmentsDir, { recursive: true });
          await fs.writeFile(path.join(attachmentsDir, `${id}.pdf`), bytes);
        });
        const first = yield* images.readAttachmentFileChunk({
          attachmentId: id,
          offset: 0,
          limit: 8,
        });
        expect(first).toMatchObject({ offset: 0, totalBytes: bytes.length, nextOffset: 8 });
        const rest = yield* images.readAttachmentFileChunk({
          attachmentId: id,
          offset: 8,
          limit: 512,
        });
        expect(rest.nextOffset).toBeNull();
        expect(
          Buffer.concat([
            Buffer.from(first.dataBase64, "base64"),
            Buffer.from(rest.dataBase64, "base64"),
          ]),
        ).toEqual(bytes);

        yield* Effect.promise(async () => {
          await fs.rm(path.join(attachmentsDir, `${id}.pdf`));
          await fs.symlink(path.join(root, "outside.pdf"), path.join(attachmentsDir, `${id}.pdf`));
        });
        for (const attachmentId of [id, ScreenshotArtifactId.make("../outside")]) {
          expect(
            (yield* images
              .readAttachmentFileChunk({ attachmentId, offset: 0, limit: 512 })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
      }).pipe(Effect.provide(layer.pipe(Layer.provide(ServerConfig.layerTest(root, root)))));
    }),
  );
});
