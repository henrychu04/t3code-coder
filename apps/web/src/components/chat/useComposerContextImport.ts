import type { RefObject } from "react";
import type { ChatComposerProps } from "./ChatComposer";
import {
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ScreenshotArtifactId,
} from "@t3tools/contracts";
import {
  type ComposerFileAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type PendingUserInput } from "../../session-logic";
import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  reviewCommentContextId,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextRecord,
  terminalContextReference,
} from "~/lib/composerContextRecords";
import { copiedComposerAttachmentFile } from "~/lib/copiedComposerAttachments";
import { countQuestionAttachments, questionAttachmentDraftId } from "../../questionAttachments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { pendingDraftWork } from "./pendingDraftWork";
import { randomUUID } from "~/lib/utils";
import { readScreenshotBlob } from "~/lib/readScreenshotBlob";
import { projectEnvironment } from "~/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { toastManager } from "../ui/toast";
import {
  type ComposerDraftContextRecords,
  uploadedContextRecordFromDraft,
} from "../composerContextPresentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * Imports copied composer context (terminal output, review comments, annotations, threads,
 * images and files) into the open draft, and counts the attachment slots already spoken for.
 */
export function useComposerContextImport(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThread: ChatComposerProps["activeThread"];
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerContextRecords: ComposerDraftContextRecords;
  readonly pendingImageCompressionsRef: RefObject<Map<string, number>>;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
}) {
  const {
    environmentId,
    activeThread,
    activeThreadId,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    pendingUserInputs,
    composerContextRecords,
    pendingImageCompressionsRef,
    pendingThreadImportsRef,
    addComposerFilesToDraft,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const readSourceAttachment = useAtomCommand(projectEnvironment.readScreenshotArtifact, {
    reportFailure: false,
  });
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const countReservedAttachments = () => {
    const questionRequest = pendingUserInputs[0];
    const otherQuestionKeys =
      questionAttachmentTarget && questionRequest && activeThreadId
        ? questionRequest.questions
            .map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                questionRequest.requestId,
                question.id,
              ),
            )
            .filter((key) => key !== questionAttachmentTarget)
        : [];
    const draft = getComposerDraft(attachmentDraftTarget);
    return (
      (draft?.images.length ?? 0) +
      (draft?.files.length ?? 0) +
      (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) +
      (pendingThreadImportsRef.current.get(attachmentTargetKey) ?? 0) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };
  const countReservedAttachmentsStable = useStableCallback(countReservedAttachments);
  /**
   * Bytes for a pasted image or file come from the copy this browser kept when it was copied
   * from an unsent draft. Otherwise an image comes back through the source workspace helper's
   * bounded attachment read (the client is the only party that can reach both). Either way it
   * re-enters this draft as a normal composer attachment under a fresh id, staged again through
   * the gateway. The pasted chip is rewritten to that id and reads as unresolved until the bytes
   * land; a failed transfer says so and leaves the chip to remove.
   */
  const runAttachmentImport = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
    importTargetKey: string,
  ) => {
    const fail = (reason: string) => {
      toastManager.add({
        type: "error",
        title: `Couldn't bring ${record.name} into this message`,
        description: `${reason} Remove the chip or attach the file again.`,
      });
    };
    let file = copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId);
    if (!file) {
      // Coder: the helper's bounded attachment read returns only signature-checked images, so a
      // pasted file chip brings its bytes only from this browser's own copy.
      if (
        record.kind !== "image" ||
        (record.mimeType !== "image/png" &&
          record.mimeType !== "image/jpeg" &&
          record.mimeType !== "image/webp")
      ) {
        fail("Only PNG, JPEG, and WebP images can be copied into another message.");
        return;
      }
      let blob: Blob;
      try {
        blob = await readScreenshotBlob(
          {
            id: ScreenshotArtifactId.make(record.attachmentId),
            name: record.name,
            mimeType: record.mimeType,
            ...(record.sizeBytes > 0 ? { sizeBytes: record.sizeBytes } : {}),
          },
          async (input) => {
            const result = await readSourceAttachment({
              environmentId: sourceEnvironmentId,
              input,
            });
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return result.value;
          },
          AbortSignal.timeout(60_000),
        );
      } catch {
        fail("The original attachment is no longer available.");
        return;
      }
      file = new File([blob], record.name, { type: record.mimeType || blob.type });
    }
    // The draft these bytes belong to may have been sent or switched away from while they
    // downloaded. Dropping them here keeps them out of whatever draft is open now.
    if (attachmentTargetKeyRef.current !== importTargetKey) return;
    if (
      (pendingThreadImportsRef.current.get(importTargetKey) ?? 0) > 0 &&
      countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      fail("The attachment limit has been reached.");
      return;
    }
    if (record.kind === "image") {
      const accepted = addComposerDraftImages(attachmentDraftTarget, [
        {
          type: "image",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        },
      ]);
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    } else {
      const accepted = addComposerFilesToDraft([
        {
          type: "file",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ]);
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    }
  };
  const importAttachmentRecord = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
  ) => {
    // The chip lands in the draft immediately while these bytes are still downloading. Count
    // the transfer against its own draft so a send cannot snapshot a message whose chip has no
    // attachment behind it, and so bytes for an abandoned draft never enter the next one.
    const importTargetKey = attachmentTargetKey;
    pendingDraftWork.begin(importTargetKey);
    await runAttachmentImport(record, localId, sourceEnvironmentId, importTargetKey).finally(() =>
      pendingDraftWork.end(importTargetKey),
    );
  };
  const importContextRecords = (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget = attachmentDraftTarget,
  ): ReadonlyMap<string, string> => {
    const rewritten = new Map<string, string>();
    for (const candidate of records) {
      // Producer ids fold into context ids, so two different excerpts can collide. Only skip
      // when the draft already holds the same payload; a colliding but different record is
      // re-minted under a fresh id so both survive the paste.
      const record = asKnownContextRecord(candidate);
      if (!record) continue;
      const existing = composerContextImportLookupIds(record).flatMap((contextId) => {
        const found = composerContextRecords.get(contextId);
        return found ? [found] : [];
      })[0];
      // Upload completion can change the server id since copy; the local bytes still match.
      if (
        sourceEnvironmentId !== null &&
        (record.kind === "image" || record.kind === "file") &&
        (existing?.kind === "image" || existing?.kind === "file") &&
        existing.record.file !== null &&
        existing.record.file ===
          copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId)
      )
        continue;
      const existingRecord =
        existing?.kind === "terminal"
          ? terminalContextRecord(existing.record)
          : existing?.kind === "review-comment"
            ? reviewCommentContextRecord(existing.record)
            : existing?.kind === "thread"
              ? existing.record
              : existing
                ? (uploadedContextRecordFromDraft(existing) ?? undefined)
                : undefined;
      if (
        existingRecord &&
        isSameComposerContextPayload(existingRecord, record) &&
        (record.kind !== "thread" || threadDraftTarget === attachmentDraftTarget)
      ) {
        continue;
      }
      const conflicts = existing !== undefined;
      switch (record.kind) {
        case "terminal": {
          const threadId = activeThread?.id ?? activeThreadId;
          if (!threadId) break;
          const imported = terminalContextDraftFromRecord(record, threadId);
          const draft = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftTerminalContexts(composerDraftTarget, [draft], {
            appendReference: false,
          });
          rewritten.set(record.contextId, terminalContextReference(draft).contextId);
          break;
        }
        case "review-comment": {
          const imported = reviewCommentFromRecord(record);
          const comment = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          rewritten.set(record.contextId, reviewCommentContextId(comment.id));
          break;
        }
        case "thread": {
          // The agent can only read threads on its own server; a pasted foreign one is dropped.
          if (record.environmentId !== environmentId) break;
          addComposerDraftThreadContexts(threadDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "image":
        case "file": {
          if (sourceEnvironmentId === null && !conflicts) {
            rewritten.set(record.contextId, record.contextId);
            break;
          }
          if (sourceEnvironmentId === null) break;
          const localId = randomUUID();
          rewritten.set(record.contextId, toKindScopedComposerContextId(record.kind, localId));
          void importAttachmentRecord(record, localId, sourceEnvironmentId);
          break;
        }
        default:
          break;
      }
    }
    return rewritten;
  };
  const importContextFragment = (
    fragment: ComposerContextClipboardFragment,
  ): ReadonlyMap<string, string> =>
    importContextRecords(fragment.records, fragment.source.environmentId);
  const importContextFragmentStable = useStableCallback(importContextFragment);

  return {
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
    importContextFragmentStable,
  };
}
