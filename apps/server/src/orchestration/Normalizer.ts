// @effect-diagnostics nodeBuiltinImport:off -- Staged uploads are read without following links.
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import * as NodeFS from "node:fs/promises";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  type ClientOrchestrationCommand,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { detectImageMimeType } from "@t3tools/shared/imageSignature";

import {
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

/** Reads a staged upload without following links; rejects anything but its exact declared size. */
async function readStagedAttachment(path: string, sizeBytes: number): Promise<Buffer> {
  const handle = await NodeFS.open(
    path,
    FILE_SYSTEM_CONSTANTS.O_RDONLY | FILE_SYSTEM_CONSTANTS.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== sizeBytes ||
      stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ) {
      throw new Error("Staged attachment is not a regular file of the declared size.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== sizeBytes) throw new Error("Staged attachment changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachments = canonicalCommand.message.attachments;
    const attachmentLimitError = getProviderAttachmentLimitError(attachments);
    if (attachmentLimitError) {
      return yield* new OrchestrationDispatchCommandError({ message: attachmentLimitError });
    }
    const clientAttachmentIds = new Set<string>();
    for (const attachment of attachments) {
      if (clientAttachmentIds.has(attachment.id)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Attachment '${attachment.name}' cannot be sent: duplicate attachment id.`,
        });
      }
      clientAttachmentIds.add(attachment.id);
    }

    const claimedAttachmentPaths: string[] = [];
    // Context records bind to attachments by the id the client knew; they follow the rename.
    const finalAttachmentIdByClientId = new Map<string, string>();
    const normalizedAttachments = yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: canonicalCommand.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }

          const normalizedAttachment = {
            ...attachment,
            id: claim.finalId,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalizedAttachment,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }

          // Coder reads the staged upload once through a no-follow handle and writes those
          // exact bytes, so a symlink or a file swapped mid-claim never reaches the thread.
          // Only PNG, JPEG, and WebP whose signature matches the declared type are accepted.
          const bytes = yield* Effect.tryPromise(() =>
            readStagedAttachment(claim.currentPath, attachment.sizeBytes),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found or size does not match.`,
                  cause,
                }),
            ),
          );
          const detectedMimeType = detectImageMimeType(bytes);
          if (
            detectedMimeType === undefined ||
            detectedMimeType !== normalizedAttachment.mimeType ||
            !isProviderSendTurnSupportedImageMimeType(detectedMimeType)
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' cannot be sent: only PNG, JPEG, and WebP images are supported.`,
            });
          }

          // Keep the pending copy until the turn succeeds. A failed thread
          // bootstrap can then retry with a fresh thread id. A copy, not a
          // hard link: an agent editing the delivered file in place must not
          // mutate the retry source.
          yield* fileSystem.writeFile(claim.finalPath, bytes, { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
          );
          claimedAttachmentPaths.push(claim.finalPath);
          finalAttachmentIdByClientId.set(attachment.id, claim.finalId);

          return normalizedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    const context = canonicalCommand.message.context;
    const normalizedContext =
      context === undefined
        ? undefined
        : {
            ...context,
            records: context.records.map((record) =>
              (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                ? {
                    ...record,
                    attachmentId:
                      finalAttachmentIdByClientId.get(record.attachmentId) ?? record.attachmentId,
                  }
                : record,
            ),
          };
    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
        ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      },
    } satisfies OrchestrationCommand;
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  const originalAttachments =
    command.type === "thread.turn.start" ? command.message.attachments : [];
  const normalizedAttachments =
    normalizedCommand.type === "thread.turn.start" ? normalizedCommand.message.attachments : [];
  if (normalizedAttachments.length === 0) return;

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    const original = originalAttachments[index];
    if (
      !original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
