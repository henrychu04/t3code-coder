import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { composerDraftHasUserContent, useComposerDraftStore } from "./composerDraftStore";

describe("existing-thread unsent drafts", () => {
  const ref = scopeThreadRef(EnvironmentId.make("draft-test"), ThreadId.make("thread"));
  const other = scopeThreadRef(EnvironmentId.make("other-workspace"), ref.threadId);
  afterEach(() => {
    useComposerDraftStore.getState().clearComposerContent(ref);
    useComposerDraftStore.getState().clearComposerContent(other);
  });
  it("tracks unsent content, ignores whitespace, and clears on discard", () => {
    const hasDraft = () =>
      composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(ref));
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setPrompt(ref, "   ");
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setPrompt(ref, "follow up on the review");
    expect(hasDraft()).toBe(true);
    expect(
      composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(other)),
    ).toBe(false);
    useComposerDraftStore.getState().clearComposerContent(ref);
    expect(hasDraft()).toBe(false);
  });
});
