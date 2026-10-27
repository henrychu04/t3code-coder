// @effect-diagnostics nodeBuiltinImport:off -- Coder: staged uploads are read without following links.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";

import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isSvgAttachment } from "@t3tools/shared/image";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { readAttachmentBytes } from "../readAttachmentBytes.ts";
import * as DocumentText from "../provider/DocumentText.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

/** Coder: reads a staged upload without following links, at exactly its declared size. */
async function readStagedAttachment(path: string, attachment: ChatAttachment): Promise<Buffer> {
  const maxBytes =
    attachment.type === "image"
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const handle = await NodeFS.open(
    path,
    FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== attachment.sizeBytes || stat.size > maxBytes) {
      throw new Error("Staged attachment is not a regular file of the declared size.");
    }
    return await readAttachmentBytes(handle, attachment.sizeBytes, maxBytes);
  } finally {
    await handle.close();
  }
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      claimedPaths,
      (path) =>
        fileSystem
          .remove(path)
          .pipe(
            Effect.ignore,
            Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true }).pipe(Effect.ignore)),
          ),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.uninterruptible);
  },
);

/** Copies preserve the pending retry source after failed bootstrap; the pending sweep reclaims it. */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const documents = yield* DocumentText.DocumentText;
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            return attachment;
          }
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            name:
              attachment.type === "file" &&
              isSvgAttachment(attachment) &&
              !/\.svg$/i.test(attachment.name)
                ? `${attachment.name}.svg`
                : attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          // Coder: read the staged upload once through a no-follow handle and write those exact
          // bytes exclusively, so a symlink or a file swapped mid-claim never reaches the thread.
          // Images must carry a PNG, JPEG, or WebP signature matching their declared type.
          // Like upstream's copy, the pending file stays behind as the retry source.
          const bytes = yield* Effect.tryPromise(() =>
            readStagedAttachment(claim.currentPath, attachment),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found or size does not match.`,
                  cause,
                }),
            ),
          );
          if (normalized.type === "image") {
            const detectedMimeType = detectImageMimeType(bytes);
            if (
              detectedMimeType === undefined ||
              detectedMimeType !== normalized.mimeType ||
              !isProviderSendTurnSupportedImageMimeType(detectedMimeType)
            ) {
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: only PNG, JPEG, and WebP images are supported.`,
              });
            }
          }
          yield* fileSystem.writeFile(claim.finalPath, bytes, { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
            Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
            Effect.uninterruptible,
          );
          const sidecar = `${claim.currentPath}.txt`;
          if (yield* fileSystem.exists(sidecar).pipe(Effect.orElseSucceed(() => false))) {
            yield* fileSystem.copyFile(sidecar, `${claim.finalPath}.txt`).pipe(
              Effect.andThen(Effect.sync(() => claimedPaths.push(`${claim.finalPath}.txt`))),
              Effect.onError(() =>
                fileSystem.remove(`${claim.finalPath}.txt`, { force: true }).pipe(Effect.ignore),
              ),
              Effect.uninterruptible,
              Effect.ignore,
            );
          } else {
            const extracted = yield* documents.ensure(claim.finalPath);
            if (extracted) claimedPaths.push(extracted);
          }
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(Effect.onError(() => releaseClaimedAttachments(claimedPaths)));
    return { attachments, claimedPaths } satisfies ClaimedAttachments;
  },
);
