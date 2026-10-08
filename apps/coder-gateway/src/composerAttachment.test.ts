// @effect-diagnostics nodeBuiltinImport:off
import { strictEqual, throws } from "node:assert";
import * as NodeFS from "node:fs/promises";
import { describe, it } from "node:test";

import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_COMPOSER_FILE_BYTES,
  validateClipboardImage,
  validateComposerFile,
  withStagedAttachment,
} from "./composerAttachment.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("clipboard image staging", () => {
  it("validates media type and file signature together", () => {
    strictEqual(validateClipboardImage("image/png", png), "png");
    throws(() => validateClipboardImage("image/jpeg", png), /does not match its media type/u);
    throws(
      () => validateClipboardImage("image/svg+xml", Buffer.from("<svg/>")),
      /must be PNG, JPEG, or WebP/u,
    );
  });

  it("deletes the staged image after success", async () => {
    let stagedPath = "";
    await withStagedAttachment(png, "png", async (localPath) => {
      stagedPath = localPath;
      strictEqual((await NodeFS.readFile(localPath)).equals(png), true);
    });
    await NodeFS.access(stagedPath).then(
      () => {
        throw new Error("staged image still exists");
      },
      () => undefined,
    );
  });
});

it("accepts exactly 10 MiB and rejects a prepared upload one byte over", () => {
  strictEqual(MAX_CLIPBOARD_IMAGE_BYTES, 10 * 1024 * 1024);
  const exact = Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES);
  png.copy(exact);
  strictEqual(validateClipboardImage("image/png", exact), "png");
  throws(
    () => validateClipboardImage("image/png", Buffer.concat([exact, Buffer.from([0])])),
    /10 MiB/,
  );
});

it("stages composer files under their name's extension up to 50 MiB", () => {
  strictEqual(MAX_COMPOSER_FILE_BYTES, 50 * 1024 * 1024);
  strictEqual(validateComposerFile("notes.MD", Buffer.from("x")), "md");
  strictEqual(validateComposerFile("Makefile", Buffer.from("x")), "bin");
  strictEqual(validateComposerFile("/etc/passwd", Buffer.from("x")), "bin");
  throws(() => validateComposerFile("empty.txt", Buffer.alloc(0)), /empty/u);
  throws(
    () => validateComposerFile("big.bin", Buffer.alloc(MAX_COMPOSER_FILE_BYTES + 1)),
    /50 MiB/u,
  );
});
