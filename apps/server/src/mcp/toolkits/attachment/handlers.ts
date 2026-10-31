import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type ChatAttachment,
  MessageId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readThread, unavailable } from "../../threadAccess.ts";
import { AttachmentToolkit } from "./tools.ts";

export function resolveAttachmentReferences(
  requested: ReadonlyArray<ChatAttachment>,
  stored: ReadonlyArray<ChatAttachment>,
) {
  const owned = new Map(stored.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(requested, (attachment) => {
    const canonical = Claims.attachmentIsPendingUpload(attachment)
      ? attachment
      : owned.get(attachment.id);
    return canonical === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments must be pending uploads or already belong to the target thread.",
          }),
        )
      : Effect.succeed(canonical);
  });
}

const invalidUpload = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Coder: stores the file at `filePath` as the pending upload `relativeUrl` names, as upstream's
 * upload route stores a POSTed body. The agent shares the workspace filesystem, so bytes never
 * pass through the bridge's bounded request files.
 */
const storeWorkspaceFile = Effect.fn("AttachmentHandlers.storeWorkspaceFile")(function* (
  relativeUrl: string,
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* Path.Path).isAbsolute(filePath)) {
    return yield* invalidUpload("`path` must be an absolute workspace path.");
  }
  const info = yield* fileSystem
    .stat(filePath)
    .pipe(Effect.mapError(() => invalidUpload(`No readable file at ${filePath}.`)));
  if (info.type !== "File") {
    return yield* invalidUpload(`${filePath} is not a regular file.`);
  }
  const claims = yield* Upload.validateAttachmentUploadToken(
    relativeUrl.slice(`${Upload.ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
  );
  if (claims === null) return yield* unavailable();
  if (Number(info.size) !== claims.sizeBytes) {
    return yield* invalidUpload(
      `${filePath} is ${Number(info.size)} bytes, but upload.sizeBytes is ${claims.sizeBytes}.`,
    );
  }
  // A read error ends the body early, which the store reports as a size mismatch.
  const stored = yield* Upload.storeAttachmentUpload(
    claims,
    fileSystem
      .stream(filePath, { bytesToRead: claims.sizeBytes })
      .pipe(Stream.catch(() => Stream.empty)),
  );
  if (!stored.ok) {
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: stored.detail,
    });
  }
});

/** The 24-hour sweep starts at upload completion, possibly one upload-URL lifetime after issue. */
const UPLOAD_OWNER_TTL_MS = 24 * 60 * 60 * 1000 + ATTACHMENT_UPLOAD_URL_TTL_MS;

const uploadOwner = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId ?? scope.requestNamespace),
);

export const layer = McpToolAccess.toLayer(
  AttachmentToolkit,
  Effect.sync(() => {
    const uploadOwners = new Map<string, { readonly owner: string; readonly issuedAt: number }>();
    return {
      // A pending upload belongs to its caller until a send claims it, so
      // linked callers may stage the uploads their own sends need.
      t3_attachment_prepare_upload: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            // Coder: a call another workspace forwards names a file in that workspace, not here.
            if ((yield* McpInvocationContext.McpInvocationContext).client?.linked === true) {
              return yield* invalidUpload(
                "Attachments cannot be uploaded from a linked workspace. Upload and send them from a thread in this workspace.",
              );
            }
            const result = yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
              Effect.mapError(unavailable),
            );
            // Coder: stage the workspace file through the upload route's own validation and store.
            yield* storeWorkspaceFile(result.relativeUrl, input.path);
            const now = yield* Clock.currentTimeMillis;
            for (const [id, entry] of uploadOwners) {
              if (now - entry.issuedAt > UPLOAD_OWNER_TTL_MS) uploadOwners.delete(id);
            }
            uploadOwners.set(result.attachmentId, { owner: yield* uploadOwner, issuedAt: now });
            // Coder: the upload is already stored, so no URL goes back.
            return { attachmentId: result.attachmentId };
          }),
        { linkedCallers: "allowed" },
      ),
      t3_attachment_discard: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            if (uploadOwners.get(input.attachmentId)?.owner !== (yield* uploadOwner)) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Only the caller that prepared a pending upload can discard it.",
              });
            }
            yield* Upload.deletePendingAttachment(input.attachmentId);
            uploadOwners.delete(input.attachmentId);
            return {};
          }),
        { linkedCallers: "allowed" },
      ),
      t3_thread_send_attachments: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const { caller, projection } = yield* readThread(input.threadId, ["messages"]);
            if (projection.thread.archivedAt !== null)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Unarchive the target thread before sending attachments.",
              });
            const attachments = yield* resolveAttachmentReferences(
              input.attachments,
              projection.messages.flatMap((message) => message.attachments),
            );
            const commandId = yield* newCommandId();
            const messageId = MessageId.make(commandId);
            const result = yield* ThreadMessageIntake.sendToThread({
              projectId: projection.thread.projectId,
              threadId: projection.thread.id,
              commandId,
              messageId,
              ...(caller === undefined ? {} : { senderThreadId: caller.id }),
              text: input.message ?? "",
              attachments,
              mode: "auto",
              createdBy: "agent",
              creationSource: "mcp",
            }).pipe(
              Effect.mapError((error) =>
                error._tag === "AttachmentClaimError"
                  ? new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    })
                  : unavailable(),
              ),
            );
            return {
              threadId: projection.thread.id,
              messageId,
              runId: result.run.id,
              status: result.run.status,
            };
          }),
      ),
    };
  }),
);
