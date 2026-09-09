import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  coderWorkspaceIdForEnvironment,
  subscribeCoderWorkspaceEnvironments,
} from "./environmentStore";
import { useComposerDraftStore } from "../composerDraftStore";
import type { ComposerPastedImage } from "../lib/composerPastedImages";
import { uploadCoderClipboardImage } from "./api";

// Like upstream's upload queue, jobs are owned by drafts, not mounted composers.
const active = new Map<string, { controller: AbortController; workspaceId: string }>();
const MAX_UPLOADS_PER_WORKSPACE = 3;
let pumping = false;

function imagesInDrafts() {
  return Object.values(useComposerDraftStore.getState().draftsByThreadKey).flatMap(
    (draft) => draft.pastedImages ?? [],
  );
}

function updateImage(id: string, update: (image: ComposerPastedImage) => ComposerPastedImage) {
  useComposerDraftStore.setState((state) => {
    for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
      const images = draft.pastedImages;
      const index = images?.findIndex((image) => image.id === id) ?? -1;
      if (!images || index < 0) continue;
      const current = images[index]!;
      const next = update(current);
      if (current === next) return state;
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [key]: {
            ...draft,
            pastedImages: images.map((image) => (image.id === id ? next : image)),
          },
        },
      };
    }
    return state;
  });
}

async function run(
  image: Extract<ComposerPastedImage, { status: "queued" }>,
  controller: AbortController,
) {
  let lastStep = -1;
  try {
    const path = await uploadCoderClipboardImage(image.workspaceId, image.file, {
      signal: controller.signal,
      onProgress: (value) => {
        const progress = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
        const step = Math.floor(progress * 20);
        if (step === lastStep || controller.signal.aborted) return;
        lastStep = step;
        updateImage(image.id, (current) =>
          current.status === "uploading" && current.progress !== progress
            ? { ...current, progress }
            : current,
        );
      },
    });
    if (!controller.signal.aborted) {
      updateImage(image.id, (current) => ({
        id: current.id,
        file: current.file,
        status: "uploaded",
        workspaceId: image.workspaceId,
        path,
      }));
    }
  } catch (cause) {
    if (!controller.signal.aborted) {
      updateImage(image.id, (current) => ({
        id: current.id,
        file: current.file,
        workspaceId: image.workspaceId,
        status: "failed",
        error: cause instanceof Error ? cause.message : "Clipboard image upload failed.",
      }));
    }
  } finally {
    active.delete(image.id);
    pump();
  }
}

function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // A project move or stash restore can change the destination. Re-key the job
    // so the old transfer is cancelled and late results cannot overwrite the new one.
    const state = useComposerDraftStore.getState();
    for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
      const environmentId =
        state.draftThreadsByThreadKey[key]?.environmentId ??
        parseScopedThreadKey(key)?.environmentId;
      const workspaceId = environmentId ? coderWorkspaceIdForEnvironment(environmentId) : null;
      if (!workspaceId) continue;
      for (const image of draft.pastedImages ?? []) {
        if (image.workspaceId !== workspaceId) {
          updateImage(image.id, () => ({
            id: crypto.randomUUID(),
            file: image.file,
            workspaceId,
            status: "queued",
          }));
        }
      }
    }
    const images = imagesInDrafts();
    const ids = new Set(images.map((image) => image.id));
    const activeByWorkspace = new Map<string, number>();
    for (const [id, { controller, workspaceId }] of active) {
      if (!ids.has(id)) controller.abort();
      activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 0) + 1);
    }
    for (const image of images) {
      if (image.status !== "queued" || active.has(image.id)) continue;
      const count = activeByWorkspace.get(image.workspaceId) ?? 0;
      if (count >= MAX_UPLOADS_PER_WORKSPACE) continue;
      const controller = new AbortController();
      active.set(image.id, { controller, workspaceId: image.workspaceId });
      activeByWorkspace.set(image.workspaceId, count + 1);
      updateImage(image.id, () => ({ ...image, status: "uploading", progress: 0 }));
      void run(image, controller);
    }
  } finally {
    pumping = false;
  }
}

useComposerDraftStore.subscribe(pump);
subscribeCoderWorkspaceEnvironments(pump);

export function retryClipboardImage(id: string) {
  updateImage(id, (image) =>
    image.status === "failed"
      ? { id: image.id, file: image.file, workspaceId: image.workspaceId, status: "queued" }
      : image,
  );
}
