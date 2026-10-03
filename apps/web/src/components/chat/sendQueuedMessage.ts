import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ChatImageAttachment } from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";

import { buildMessageContext, terminalContextReference } from "../../lib/composerContextRecords";
import { removeInlineContextReference } from "../../lib/composerContextReferences";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { newMessageId } from "../../lib/utils";
import { latestCompletedToolActivityId, useQueuedMessageStore } from "../../queuedMessageStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThread, readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import {
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  resolveThreadMetadataUpdateForNextTurn,
  revokeBlobPreviewUrl,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * Sends one queued message as a turn on its thread. `QueuedMessageSender`
 * calls it when the head message is due, and Send now calls it directly. It
 * reads nothing from the composer, so it works for threads that are not on
 * screen. A failed send stays at the head of the queue, held for Send now.
 */
export async function sendQueuedMessage(
  threadRef: ScopedThreadRef,
  messageId: string,
): Promise<void> {
  const { environmentId, threadId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const queue = useQueuedMessageStore.getState();
  const message = queue.beginSend(
    threadKey,
    messageId,
    latestCompletedToolActivityId(readThread(threadRef)?.activities ?? []),
  );
  if (!message) return;
  const { sendSettings } = message;
  const attachments = [...message.images, ...message.files];
  try {
    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: message.prompt,
      imageCount: attachments.length,
      terminalContexts: message.terminalContexts,
      elementContextCount: message.reviewComments.length,
    });
    // Only expired terminal context was left. Retrying would block the queue
    // on every boundary, so drop it and let the queue move on.
    if (!hasSendableContent) {
      queue.finishSend(threadKey, message.id);
      return;
    }
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const prompt = message.terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        message.prompt,
      )
      .trim();
    const text = applyClaudePromptEffortPrefix(
      prompt || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      sendSettings.promptEffort,
    );

    if (message.files.length > 0) throw new Error("Only image attachments are supported.");
    for (const image of message.images) {
      startAttachmentUpload({ environmentId, image, draftTarget: threadRef });
    }
    await awaitAttachmentUploads(message.images.map((image) => image.id));
    const uploadedAttachments = getUploadedAttachments({ environmentId, images: message.images });
    const wireAttachments =
      uploadedAttachments?.filter(
        (attachment): attachment is ChatImageAttachment => attachment.type === "image",
      ) ?? null;
    if (wireAttachments === null) throw new Error("Retry or remove failed image uploads.");

    // The server starts the turn with the thread's stored modes, so a change
    // made in the composer before queueing is saved first.
    const createdAt = new Date().toISOString();
    const shell = readThreadShell(threadRef);
    const metadataUpdate = shell
      ? resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: shell.modelSelection,
          nextModelSelection: sendSettings.modelSelection,
          currentBranch: shell.branch,
        })
      : null;
    if (metadataUpdate) {
      await run(threadEnvironment.updateMetadata, {
        environmentId,
        input: { threadId, ...metadataUpdate },
      });
    }
    if (shell && shell.runtimeMode !== sendSettings.runtimeMode) {
      await run(threadEnvironment.setRuntimeMode, {
        environmentId,
        input: { threadId, runtimeMode: sendSettings.runtimeMode, createdAt },
      });
    }
    if (shell && shell.interactionMode !== sendSettings.interactionMode) {
      await run(threadEnvironment.setInteractionMode, {
        environmentId,
        input: { threadId, interactionMode: sendSettings.interactionMode, createdAt },
      });
    }

    // Stop hands a preparing message back to the composer. Past this point
    // the send can no longer be taken back.
    const thread = readThread(threadRef) ?? undefined;
    if (!queue.markDispatching(threadKey, message.id, createLocalDispatchSnapshot(thread))) return;
    const context = buildMessageContext({
      terminalContexts: sendableTerminalContexts,
      reviewComments: message.reviewComments,
      attachments: attachments.map((attachment, index) => ({
        attachment,
        attachmentId: wireAttachments[index]?.id ?? attachment.id,
      })),
    });
    await run(threadEnvironment.startTurn, {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text,
          attachments: wireAttachments,
          ...(context !== undefined ? { context } : {}),
        },
        modelSelection: sendSettings.modelSelection,
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt,
      },
    });
    queue.finishSend(threadKey, message.id);
    releaseDraftAttachments(attachments);
    for (const image of message.images) revokeBlobPreviewUrl(image.previewUrl);
  } catch (error) {
    if (!queue.failSend(threadKey, message.id)) return;
    const title = readThreadShell(threadRef)?.title;
    toastManager.add({
      type: "error",
      title: title ? `Queued message not sent in "${title}"` : "Queued message not sent",
      description: error instanceof Error ? error.message : "Use Send now to try again.",
    });
  }
}
