// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MAX_SCREENSHOT_ARTIFACT_BYTES, ThreadId } from "@t3tools/contracts";
import { readProjectImage } from "./ProjectImages.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const fixture = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), ".project-images-"))),
  (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
);
it.effect(
  "reads a copied image without a provider event, handles changes, and creates no artifact copies",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const cwd = path.join(root, "project");
      yield* Effect.promise(async () => {
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(root, "generated.png"), png);
        await fs.copyFile(path.join(root, "generated.png"), path.join(cwd, "copied.png"));
      });
      const input = {
        threadId: ThreadId.make("thread"),
        cwd,
        filePath: "copied.png",
        offset: 0,
        limit: 16,
      };
      const first = yield* readProjectImage(input);
      expect((yield* readProjectImage({ ...input, limit: 512 })).dimensions).toEqual({
        width: 1,
        height: 1,
      });
      const second = yield* readProjectImage({
        ...input,
        offset: first.nextOffset!,
        limit: 512,
        revision: first.revision,
      });
      expect(
        Buffer.concat([
          Buffer.from(first.dataBase64, "base64"),
          Buffer.from(second.dataBase64, "base64"),
        ]),
      ).toEqual(png);
      for (let i = 0; i < 25; i++)
        expect((yield* readProjectImage(input)).revision).toBe(first.revision);
      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual(["generated.png", "project"]);
      yield* Effect.promise(() =>
        fs.rename(path.join(cwd, "copied.png"), path.join(cwd, "renamed.png")),
      );
      expect((yield* readProjectImage(input).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* readProjectImage({ ...input, filePath: "renamed.png" })).mimeType).toBe(
        "image/png",
      );
      yield* Effect.promise(() =>
        fs.writeFile(path.join(cwd, "copied.png"), Buffer.concat([png, Buffer.from("new bytes")])),
      );
      expect(
        (yield* readProjectImage({
          ...input,
          offset: first.nextOffset!,
          revision: first.revision,
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const retry = yield* readProjectImage(input);
      expect(retry.revision).not.toBe(first.revision);
      expect(retry.totalBytes).toBeGreaterThan(first.totalBytes);
      yield* Effect.promise(() => fs.rm(path.join(cwd, "copied.png")));
      expect((yield* readProjectImage(input).pipe(Effect.result))._tag).toBe("Failure");
    }),
);
it.effect(
  "reads exact images outside the project and rejects non-images and invalid continuation reads",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const cwd = path.join(root, "project");
      yield* Effect.promise(async () => {
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(root, "outside.png"), png);
        await fs.writeFile(path.join(cwd, "ok.png"), png);
        await fs.writeFile(path.join(cwd, "fake.png"), "not an image");
        await fs.writeFile(path.join(cwd, "wrong.jpg"), png);
        await fs.writeFile(path.join(cwd, "large.png"), png);
        await fs.truncate(path.join(cwd, "large.png"), MAX_SCREENSHOT_ARTIFACT_BYTES + 1);
        await fs.symlink(path.join(cwd, "ok.png"), path.join(cwd, "link.png"));
        await fs.symlink(root, path.join(cwd, "escape"));
      });
      const input = {
        threadId: ThreadId.make("thread"),
        cwd,
        filePath: "ok.png",
        offset: 0,
        limit: 512,
      };
      for (const filePath of [
        "../outside.png",
        path.join(root, "outside.png"),
        "escape/outside.png",
        "link.png",
        "./ok.png",
        "dir/../ok.png",
      ]) {
        expect((yield* readProjectImage({ ...input, filePath })).dataBase64).toBe(
          png.toString("base64"),
        );
      }
      for (const filePath of [
        "https://example.com/outside.png",
        "//example.com/outside.png",
        "fake.png",
        "wrong.jpg",
        "large.png",
        "missing.png",
        "dir\\ok.png",
        "ok.png\0",
      ]) {
        const result = yield* readProjectImage({ ...input, filePath }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(JSON.stringify(result.failure)).not.toContain(root);
      }
      expect((yield* readProjectImage({ ...input, offset: 10 }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
);
