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
});
