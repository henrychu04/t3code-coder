import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { extractComposerPastedImageAttachmentIds } from "@t3tools/shared/composerTrigger";
import { afterEach, expect, it } from "vite-plus/test";
import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { usePromptStashStore } from "../promptStashStore";
import { appendPastedImagesToPrompt } from "./composerPastedImages";

const ref = scopeThreadRef(EnvironmentId.make("image-test"), ThreadId.make("one"));
const other = scopeThreadRef(ref.environmentId, ThreadId.make("two"));
const image = {
  id: "image-one",
  status: "uploaded" as const,
  workspaceId: "workspace",
  path: "/home/user/.t3-coder/attachments/11111111-1111-4111-8111-111111111111.png",
  file: new File(["image"], "Screenshot.png", { type: "image/png" }),
};
afterEach(() => {
  useComposerDraftStore.getState().clearComposerContent(ref);
  useComposerDraftStore.getState().clearComposerContent(other);
  usePromptStashStore.setState({ entries: [] });
});

it("keeps images separate from edits and adds valid references only for sending", () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(ref, "Text typed while uploading");
  store.setPastedImages(ref, [image]);
  store.setPrompt(ref, "More typing after upload");
  const draft = store.getComposerDraft(ref)!;
  expect(draft.prompt).toBe("More typing after upload");
  expect(draft.pastedImages?.[0]?.file).toBe(image.file);
  expect(store.getComposerDraft(other)).toBeNull();
  const outgoing = appendPastedImagesToPrompt(draft.prompt, draft.pastedImages!);
  expect(outgoing).toContain("More typing after upload\n\n");
  expect(extractComposerPastedImageAttachmentIds(outgoing)).toEqual([
    "11111111-1111-4111-8111-111111111111.png",
  ]);
  store.setPastedImages(ref, []);
  expect(appendPastedImagesToPrompt(draft.prompt, [])).toBe(draft.prompt);
  expect(store.getComposerDraft(ref)?.prompt).toBe(draft.prompt);
});

it("retains image-only drafts, moves attachments with the draft, and clears them on send", () => {
  const store = useComposerDraftStore.getState();
  store.setPastedImages(ref, [image]);
  expect(composerDraftHasUserContent(store.getComposerDraft(ref))).toBe(true);
  expect(
    extractComposerPastedImageAttachmentIds(appendPastedImagesToPrompt("", [image])),
  ).toHaveLength(1);
  store.moveComposerPrompt(ref, other);
  expect(composerDraftHasUserContent(store.getComposerDraft(ref))).toBe(false);
  expect(store.getComposerDraft(other)?.pastedImages?.[0]?.file).toBe(image.file);
  store.clearComposerContent(other);
  expect(composerDraftHasUserContent(store.getComposerDraft(other))).toBe(false);
  expect(store.getComposerDraft(other)?.pastedImages ?? []).toEqual([]);
});

it("keeps preview bytes in memory when an image-only draft is stashed and restored", () => {
  const stash = usePromptStashStore.getState();
  stash.stashEntry({
    id: "image-stash",
    environmentId: ref.environmentId,
    createdAt: "2026-09-08T00:00:00Z",
    prompt: "",
    pastedImages: [image],
  });
  const entry = stash.takeEntry("image-stash").entry!;
  useComposerDraftStore.getState().setPastedImages(ref, entry.pastedImages!);
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.pastedImages?.[0]?.file).toBe(
    image.file,
  );
  expect(usePromptStashStore.getState().entries).toEqual([]);
});
