// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PastedImageAttachmentId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { assert } from "vite-plus/test";

import {
  PastedImageAttachmentError,
  resolvePastedImageAttachment,
  resolvePastedImageAttachments,
} from "./PastedImageAttachments.ts";

const decodeAttachmentId = Schema.decodeSync(PastedImageAttachmentId);
const IMAGE_ID = decodeAttachmentId("550e8400-e29b-41d4-a716-446655440000.png");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

it.layer(NodeServices.layer)("resolvePastedImageAttachment", (it) => {
  it.effect("reads a generated regular image and returns native Codex input", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-" });
      yield* fileSystem.writeFile(NodePath.join(attachmentsDir, IMAGE_ID), PNG_BYTES);

      const resolved = yield* resolvePastedImageAttachment({
        attachmentsDir,
        attachment: { type: "image", id: IMAGE_ID },
      });

      assert.equal(resolved.mimeType, "image/png");
      assert.equal(resolved.path, NodePath.join(attachmentsDir, IMAGE_ID));
      assert.equal(resolved.dataUrl, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    }),
  );

  it.effect("rejects attachments above main's 10 MiB provider-input limit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-" });
      const file = NodePath.join(attachmentsDir, IMAGE_ID);
      yield* fileSystem.writeFile(file, PNG_BYTES);
      yield* Effect.promise(() => NodeFS.truncate(file, 10 * 1024 * 1024 + 1));
      const failure = yield* Effect.flip(
        resolvePastedImageAttachment({
          attachmentsDir,
          attachment: { type: "image", id: IMAGE_ID },
        }),
      );
      assert.instanceOf(failure, PastedImageAttachmentError);
    }),
  );

  it.effect("bounds one message's images to the 80 MiB total", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-" });
      // Eight 10 MiB images fill the budget exactly; a ninth byte exceeds it.
      const ids = Array.from({ length: 9 }, (_, index) =>
        decodeAttachmentId(`550e8400-e29b-41d4-a716-44665544000${index}.png`),
      );
      for (const [index, id] of ids.entries()) {
        const file = NodePath.join(attachmentsDir, id);
        yield* fileSystem.writeFile(file, PNG_BYTES);
        yield* Effect.promise(() => NodeFS.truncate(file, index < 8 ? 10 * 1024 * 1024 : 9));
      }
      const attachments = ids.map((id) => ({ type: "image" as const, id }));
      const withinBudget = yield* resolvePastedImageAttachments({
        attachmentsDir,
        attachments: attachments.slice(0, 8),
      });
      assert.equal(withinBudget.length, 8);
      const failure = yield* Effect.flip(
        resolvePastedImageAttachments({ attachmentsDir, attachments }),
      );
      assert.instanceOf(failure, PastedImageAttachmentError);
      assert.include(failure.message, "80 MiB");
    }),
  );

  it.effect("rejects symlinks and signature mismatches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-" });
      const outside = NodePath.join(attachmentsDir, "outside.png");
      yield* fileSystem.writeFile(outside, PNG_BYTES);
      yield* Effect.tryPromise({
        try: () => NodeFS.symlink(outside, NodePath.join(attachmentsDir, IMAGE_ID)),
        catch: (cause) => cause,
      });

      const symlinkError = yield* Effect.flip(
        resolvePastedImageAttachment({
          attachmentsDir,
          attachment: { type: "image", id: IMAGE_ID },
        }),
      );
      assert.instanceOf(symlinkError, PastedImageAttachmentError);

      yield* Effect.tryPromise({
        try: () => NodeFS.rm(NodePath.join(attachmentsDir, IMAGE_ID)),
        catch: (cause) => cause,
      });
      yield* fileSystem.writeFileString(NodePath.join(attachmentsDir, IMAGE_ID), "not an image");
      const signatureError = yield* Effect.flip(
        resolvePastedImageAttachment({
          attachmentsDir,
          attachment: { type: "image", id: IMAGE_ID },
        }),
      );
      assert.instanceOf(signatureError, PastedImageAttachmentError);
    }),
  );
});
