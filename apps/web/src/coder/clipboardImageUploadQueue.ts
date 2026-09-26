import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { compressImageToByteLimit } from "../lib/imageCompression";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
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

// Failed uploads retry once their workspace reconnects, like upstream's queue.
// A reconnect bumps the workspace epoch; an upload that started before it and
// then fails is requeued, since its failure most likely came from the drop.
const reconnectEpochByWorkspace = new Map<string, number>();
const watchedEnvironments = new Set<EnvironmentId>();

function isEnvironmentConnected(environmentId: EnvironmentId): boolean {
  return Option.exists(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    (state) => state.phase === "connected",
  );
}

function watchEnvironmentReconnects(environmentId: EnvironmentId) {
  if (watchedEnvironments.has(environmentId)) return;
  watchedEnvironments.add(environmentId);
  let wasConnected = isEnvironmentConnected(environmentId);
  appAtomRegistry.subscribe(environmentCatalog.stateAtom(environmentId), () => {
    const connected = isEnvironmentConnected(environmentId);
    const reconnected = connected && !wasConnected;
    wasConnected = connected;
    if (!reconnected) return;
    const workspaceId = coderWorkspaceIdForEnvironment(environmentId);
    if (!workspaceId) return;
    reconnectEpochByWorkspace.set(
      workspaceId,
      (reconnectEpochByWorkspace.get(workspaceId) ?? 0) + 1,
    );
    for (const image of imagesInDrafts()) {
      if (image.workspaceId === workspaceId && image.status === "failed") {
        retryClipboardImage(image.id);
      }
    }
  });
}

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
  const startedEpoch = reconnectEpochByWorkspace.get(image.workspaceId) ?? 0;
  try {
    const prepared = await compressImageToByteLimit(image.file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    controller.signal.throwIfAborted();
    if (!prepared.ok)
      throw new Error(
        prepared.reason === "unreadable"
          ? "This file could not be read as an image."
          : "This image is too large to attach, even after resizing to the 10 MiB limit.",
      );
    updateImage(image.id, (current) => ({ ...current, file: prepared.file }));
    const path = await uploadCoderClipboardImage(image.workspaceId, prepared.file, {
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
    if (
      !controller.signal.aborted &&
      (reconnectEpochByWorkspace.get(image.workspaceId) ?? 0) !== startedEpoch
    ) {
      updateImage(image.id, (current) => ({
        id: current.id,
        file: current.file,
        workspaceId: image.workspaceId,
        status: "queued",
      }));
    } else if (!controller.signal.aborted) {
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
    // Keep the draft image identity (including inline references) across moves.
    // Cancel the old destination's job before starting its replacement.
    const state = useComposerDraftStore.getState();
    for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
      const environmentId =
        state.draftThreadsByThreadKey[key]?.environmentId ??
        parseScopedThreadKey(key)?.environmentId;
      const workspaceId = environmentId ? coderWorkspaceIdForEnvironment(environmentId) : null;
      if (!workspaceId || !environmentId) continue;
      if ((draft.pastedImages?.length ?? 0) > 0) watchEnvironmentReconnects(environmentId);
      for (const image of draft.pastedImages ?? []) {
        if (image.workspaceId !== workspaceId) {
          updateImage(image.id, () => ({
            id: image.id,
            file: image.file,
            workspaceId,
            status: "queued",
          }));
        }
      }
    }
    const images = imagesInDrafts();
    const imagesById = new Map(images.map((image) => [image.id, image]));
    const activeByWorkspace = new Map<string, number>();
    for (const [id, { controller, workspaceId }] of active) {
      if (imagesById.get(id)?.workspaceId !== workspaceId) controller.abort();
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
