import { detectImageMimeType } from "@t3tools/shared/imageSignature";
// @effect-diagnostics nodeBuiltinImport:off -- Images live in the Linux workspace.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../attachmentStore.ts";

type PastedImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ResolvedPastedImageAttachment {
  readonly path: string;
  readonly mimeType: PastedImageMimeType;
  readonly dataUrl: string;
  readonly sizeBytes: number;
}

export class PastedImageAttachmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PastedImageAttachmentError";
  }
}

export const resolvePastedImageAttachment = Effect.fn("resolvePastedImageAttachment")(
  function* (input: { readonly attachmentsDir: string; readonly attachment: ChatAttachment }) {
    const expectedMimeType = input.attachment.mimeType.toLowerCase();
    if (
      input.attachment.type !== "image" ||
      !isProviderSendTurnSupportedImageMimeType(expectedMimeType)
    ) {
      return yield* Effect.fail(
        new PastedImageAttachmentError("Pasted image attachment type is unsupported."),
      );
    }
    const path = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment: input.attachment,
    });
    if (!path || NodePath.dirname(path) !== NodePath.resolve(input.attachmentsDir)) {
      return yield* Effect.fail(
        new PastedImageAttachmentError("Pasted image attachment id is invalid."),
      );
    }

    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFS.open(
          path,
          FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size === 0 || stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            throw new Error("Pasted image attachment has an invalid size or file type.");
          }
          const bytes = await handle.readFile();
          const mimeType = detectImageMimeType(bytes);
          if (mimeType !== expectedMimeType) {
            throw new Error("Pasted image attachment content does not match its declared type.");
          }
          return {
            path,
            mimeType,
            dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
            sizeBytes: bytes.byteLength,
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

/**
 * Resolve one message's images in order, bounding their combined size so a turn
 * with many attachments cannot exceed the shared per-message image budget.
 */
export const resolvePastedImageAttachments = Effect.fn("resolvePastedImageAttachments")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    const resolved: Array<ResolvedPastedImageAttachment & { readonly type: "image" }> = [];
    for (const attachment of input.attachments) {
      const image = {
        type: "image" as const,
        ...(yield* resolvePastedImageAttachment({
          attachmentsDir: input.attachmentsDir,
          attachment,
        })),
      };
      resolved.push(image);
      // Legacy attachments carry no size, so bound the bytes actually read.
      const limitError = getProviderAttachmentLimitError(resolved);
      if (limitError) return yield* Effect.fail(new PastedImageAttachmentError(limitError));
    }
    return resolved;
  },
);
