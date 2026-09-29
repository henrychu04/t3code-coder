// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

import { readAttachmentBytes } from "./readAttachmentBytes.ts";

async function withAttachment(
  test: (handle: NodeFS.FileHandle, path: string) => Promise<void>,
): Promise<void> {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bounded-attachment-"));
  const path = NodePath.join(directory, "image.png");
  await NodeFS.writeFile(path, Buffer.from([1, 2, 3]));
  const handle = await NodeFS.open(path, "r");
  try {
    await test(handle, path);
  } finally {
    await handle.close();
    await NodeFS.rm(directory, { recursive: true, force: true });
  }
}

describe("readAttachmentBytes", () => {
  it("reads the exact inspected bytes", () =>
    withAttachment(async (handle) => {
      const stat = await handle.stat();
      expect(await readAttachmentBytes(handle, stat.size)).toEqual(Buffer.from([1, 2, 3]));
    }));

  it("rejects a file that grows after inspection", () =>
    withAttachment(async (handle, path) => {
      const stat = await handle.stat();
      await NodeFS.appendFile(path, Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES));
      await expect(readAttachmentBytes(handle, stat.size)).rejects.toThrow("changed while reading");
    }));

  it("rejects a file that shrinks after inspection", () =>
    withAttachment(async (handle, path) => {
      const stat = await handle.stat();
      await NodeFS.truncate(path, 1);
      await expect(readAttachmentBytes(handle, stat.size)).rejects.toThrow("changed while reading");
    }));

  it("accepts an image at the byte limit", () =>
    withAttachment(async (handle, path) => {
      await NodeFS.writeFile(path, Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, 7));
      expect(
        (await readAttachmentBytes(handle, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)).byteLength,
      ).toBe(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    }));

  it.each([0, -1, 1.5, NaN, Infinity, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1])(
    "rejects invalid size %s before reading",
    (size) =>
      withAttachment(async (handle) => {
        await expect(readAttachmentBytes(handle, size)).rejects.toThrow("size is invalid");
      }),
  );
});
