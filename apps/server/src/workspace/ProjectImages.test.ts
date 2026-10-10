// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MAX_PROJECT_HTML_BYTES,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  ThreadId,
} from "@t3tools/contracts";
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
it.effect(
  "reads additional browser image, video, and audio formats only when signatures match",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const cwd = path.join(root, "project");
      const mp4 = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from("ftypisom"),
        Buffer.alloc(12),
      ]);
      const files: Record<string, Buffer | string> = {
        "anim.gif": Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
        "icon.svg": '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
        "clip.mp4": mp4,
        "clip.mov": mp4,
        "clip.webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
        "clip.ogv": Buffer.from("OggS\0\0\0\0", "latin1"),
        "clip.mkv": Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
        "clip.avi": Buffer.from("RIFF\x00\x00\x00\x00AVI LIST", "latin1"),
        "fake.avi": Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1"),
        "song.mp3": Buffer.from("ID3\x04\x00\x00\x00\x00", "latin1"),
        "tone.wav": Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1"),
        "voice.opus": Buffer.from("OggS\0\0\0\0", "latin1"),
        "track.flac": Buffer.from("fLaC\0\0\0\0", "latin1"),
        "track.m4a": mp4,
        "fake.mp4": "not a video",
        "fake.mp3": "not audio",
        "fake.svg": "plain text",
        "renamed.gif": mp4,
        "large.png": png,
        "large.mp4": mp4,
      };
      yield* Effect.promise(async () => {
        await fs.mkdir(cwd);
        for (const [name, content] of Object.entries(files))
          await fs.writeFile(path.join(cwd, name), content);
        // Images keep their 20 MiB bound; videos may be larger.
        await fs.truncate(path.join(cwd, "large.png"), MAX_SCREENSHOT_ARTIFACT_BYTES + 1);
        await fs.truncate(path.join(cwd, "large.mp4"), MAX_SCREENSHOT_ARTIFACT_BYTES + 1);
      });
      const read = (filePath: string) =>
        readProjectImage({
          threadId: ThreadId.make("thread"),
          cwd,
          filePath,
          offset: 0,
          limit: 512,
        });
      for (const [filePath, mimeType] of [
        ["anim.gif", "image/gif"],
        ["icon.svg", "image/svg+xml"],
        ["clip.mp4", "video/mp4"],
        ["clip.mov", "video/quicktime"],
        ["clip.webm", "video/webm"],
        ["clip.ogv", "video/ogg"],
        ["clip.mkv", "video/x-matroska"],
        ["clip.avi", "video/x-msvideo"],
        ["large.mp4", "video/mp4"],
        ["song.mp3", "audio/mpeg"],
        ["tone.wav", "audio/wav"],
        ["voice.opus", "audio/ogg"],
        ["track.flac", "audio/flac"],
        ["track.m4a", "audio/mp4"],
      ] as const)
        expect((yield* read(filePath)).mimeType).toBe(mimeType);
      for (const filePath of [
        "fake.mp4",
        "fake.mp3",
        "fake.avi",
        "fake.svg",
        "renamed.gif",
        "large.png",
      ])
        expect((yield* read(filePath).pipe(Effect.result))._tag).toBe("Failure");
    }),
);

// Coder: PDF and HTML previews read only project files within their own bounds.
it.effect("reads project PDF and HTML documents but not ones outside the project", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    const cwd = path.join(root, "project");
    yield* Effect.promise(async () => {
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "spec.pdf"), "%PDF-1.7\n%stub\n");
      await fs.writeFile(path.join(cwd, "page.html"), "<!doctype html><p>page</p>");
      await fs.writeFile(path.join(cwd, "fake.pdf"), "not a pdf");
      await fs.writeFile(path.join(cwd, "binary.html"), Buffer.from([60, 0, 62]));
      await fs.writeFile(path.join(cwd, "huge.html"), "<p>");
      await fs.truncate(path.join(cwd, "huge.html"), MAX_PROJECT_HTML_BYTES + 1);
      await fs.writeFile(path.join(root, "outside.pdf"), "%PDF-1.7\n");
    });
    const read = (filePath: string) =>
      readProjectImage({ threadId: ThreadId.make("thread"), cwd, filePath, offset: 0, limit: 512 });
    expect((yield* read("spec.pdf")).mimeType).toBe("application/pdf");
    expect((yield* read("page.html")).mimeType).toBe("text/html");
    for (const filePath of ["fake.pdf", "binary.html", "huge.html", "../outside.pdf"]) {
      expect((yield* read(filePath).pipe(Effect.result))._tag, filePath).toBe("Failure");
    }
    expect((yield* read(path.join(root, "outside.pdf")).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
