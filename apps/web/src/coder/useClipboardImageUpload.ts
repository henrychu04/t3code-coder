import { collectDraftImageReferences } from "../lib/composerInlineContext";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { extractComposerPastedImageAttachmentIds } from "@t3tools/shared/composerTrigger";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { coderWorkspaceIdForEnvironment } from "./environmentStore";
import { retryClipboardImage } from "./clipboardImageUploadQueue";

/** Captures the workspace when queued; navigation does not re-route pending transfers. */
export function useClipboardImageUpload(
  environmentId: EnvironmentId,
  target: ScopedThreadRef | DraftId,
  onError: (message: string | null) => void,
) {
  const upload = (files: ReadonlyArray<File>) => {
    const workspaceId = coderWorkspaceIdForEnvironment(environmentId);
    if (workspaceId === null) {
      onError("The Coder workspace is not connected.");
      return;
    }
    // Browsers may omit MIME metadata for picked or dropped files. The gateway still
    // validates the bytes, so a filename fallback cannot make a non-image pass.
    files = files.map((file) => {
      if (file.type) return file;
      const extension = file.name.split(".").at(-1)?.toLowerCase();
      const type =
        extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : extension === "jpg" || extension === "jpeg"
              ? "image/jpeg"
              : "";
      return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
    });
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        onError("Image must be PNG, JPEG, or WebP.");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        onError("Image exceeds the 20 MiB limit.");
        return;
      }
    }
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(target);
    const images = draft?.pastedImages ?? [];
    if (
      images.length +
        files.length +
        extractComposerPastedImageAttachmentIds(draft?.prompt ?? "").length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      onError(`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`);
      return;
    }
    onError(null);
    store.setPastedImages(target, [
      ...images,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        workspaceId,
        status: "queued" as const,
      })),
    ]);
  };
  const remove = (id: string) => {
    onError(null);
    const store = useComposerDraftStore.getState();
    let prompt = store.getComposerDraft(target)?.prompt ?? "";
    for (const reference of collectDraftImageReferences(prompt).reverse()) {
      if (reference.id === id)
        prompt = prompt.slice(0, reference.start) + prompt.slice(reference.end);
    }
    store.setPrompt(target, prompt);
    store.setPastedImages(
      target,
      (store.getComposerDraft(target)?.pastedImages ?? []).filter((image) => image.id !== id),
    );
  };
  return { upload, remove, retry: retryClipboardImage };
}
