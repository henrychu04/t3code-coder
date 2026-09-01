// @effect-diagnostics nodeBuiltinImport:off -- Images live in the Linux workspace.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import type { PastedImageAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PastedImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ResolvedPastedImageAttachment {
  readonly path: string;
  readonly mimeType: PastedImageMimeType;
  readonly dataUrl: string;
}

export class PastedImageAttachmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PastedImageAttachmentError";
  }
}

function detectMimeType(bytes: Buffer): PastedImageMimeType | undefined {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.byteLength
  ) {
    return "image/webp";
  }
  return undefined;
}

const expectedMimeTypeByExtension: Readonly<Record<string, PastedImageMimeType>> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export const resolvePastedImageAttachment = Effect.fn("resolvePastedImageAttachment")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly attachment: PastedImageAttachment;
  }) {
    const id = input.attachment.id;
    if (NodePath.basename(id) !== id) {
      return yield* Effect.fail(
        new PastedImageAttachmentError("Pasted image attachment id is invalid."),
      );
    }
    const extension = NodePath.extname(id).slice(1).toLowerCase();
    const expectedMimeType = expectedMimeTypeByExtension[extension];
    if (!expectedMimeType) {
      return yield* Effect.fail(
        new PastedImageAttachmentError("Pasted image attachment type is unsupported."),
      );
    }
    const path = NodePath.join(input.attachmentsDir, id);

    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFS.open(
          path,
          FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PASTED_IMAGE_BYTES) {
            throw new Error("Pasted image attachment has an invalid size or file type.");
          }
          const bytes = await handle.readFile();
          const mimeType = detectMimeType(bytes);
          if (mimeType !== expectedMimeType) {
            throw new Error("Pasted image attachment content does not match its filename.");
          }
          return {
            path,
            mimeType,
            dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
          } satisfies ResolvedPastedImageAttachment;
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new PastedImageAttachmentError("Pasted image attachment could not be read safely.", {
          cause,
        }),
    });

    return resolved;
  },
);
