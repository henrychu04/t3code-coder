// @effect-diagnostics nodeBuiltinImport:off
import { strictEqual, throws } from "node:assert";
import * as NodeFS from "node:fs/promises";
import { describe, it } from "node:test";

import { validateClipboardImage, withStagedClipboardImage } from "./clipboardImage.ts";

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
    await withStagedClipboardImage(png, "png", async (localPath) => {
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
