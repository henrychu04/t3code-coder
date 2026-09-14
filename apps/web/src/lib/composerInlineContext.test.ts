import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, expect, it } from "vite-plus/test";
import {
  collectInlineComposerContexts,
  imageContextReference,
  longTextContextReference,
} from "./composerInlineContext";
import { appendPastedImagesToPrompt, pastedImageSendBlockReason } from "./composerPastedImages";
import { useComposerDraftStore } from "../composerDraftStore";
import { formatReviewCommentContext, type ReviewCommentContext } from "../reviewCommentContext";

const ref = scopeThreadRef(EnvironmentId.make("inline-context"), ThreadId.make("one"));
const imageId = "11111111-1111-4111-8111-111111111111";
const comment: ReviewCommentContext = {
  id: "comment-one",
  sectionId: "working",
  sectionTitle: "Working changes",
  filePath: "a.ts",
  startIndex: 0,
  endIndex: 1,
  rangeLabel: "L1–2",
  text: "Please simplify",
  diff: "-old\n+new",
  selection: { start: 1, end: 2, side: "additions", endSide: "additions" },
};
afterEach(() => useComposerDraftStore.getState().clearComposerContent(ref));

it("preserves comment identity, selection, annotations, and edits in the draft text", () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(ref, "Review this");
  store.addReviewComment(ref, comment);
  const contexts = collectInlineComposerContexts(store.getComposerDraft(ref)!.prompt);
  expect(contexts).toHaveLength(1);
  expect(contexts[0]?.context).toEqual({
    kind: "review-comment",
    comment: { ...comment, fenceLanguage: "diff" },
  });
  store.addReviewComment(ref, { ...comment, text: "Updated" });
  const updated = store.getComposerDraft(ref)!;
  expect(collectInlineComposerContexts(updated.prompt)).toHaveLength(1);
  expect(updated.prompt).toContain("Updated");
  expect(updated.prompt).not.toContain("Please simplify");
  expect(updated.reviewComments).toEqual([]);
  store.removeReviewComment(ref, comment.id);
  expect(store.getComposerDraft(ref)?.prompt.trim()).toBe("Review this");
});

it("folds long text without changing its bytes or inventing an attachment", () => {
  const text = "plain text 雪\n".repeat(4000);
  const [folded] = collectInlineComposerContexts(longTextContextReference(text));
  expect(folded?.context).toEqual({ kind: "text", text });
  expect(appendPastedImagesToPrompt(longTextContextReference(text), [])).toBe(text);
  expect(collectInlineComposerContexts("ordinary text")).toEqual([]);
});

it("does not extract nested chips from a review comment", () => {
  const source = formatReviewCommentContext({ ...comment, text: imageContextReference(imageId) });
  expect(pastedImageSendBlockReason([], source)).toBeNull();
  expect(appendPastedImagesToPrompt(source, [])).toBe(source);
  expect(collectInlineComposerContexts(source).map((entry) => entry.context.kind)).toEqual([
    "review-comment",
  ]);
});

it("resolves inline images only from this draft's uploaded copies, without appending duplicates", () => {
  const image = {
    id: imageId,
    status: "uploaded" as const,
    workspaceId: "workspace",
    path: `/home/user/.t3-coder/attachments/${imageId}.png`,
    file: new File(["png"], "Screenshot.png", { type: "image/png" }),
  };
  const source = `Before ${imageContextReference(imageId)} after`;
  const output = appendPastedImagesToPrompt(source, [image]);
  expect(output).not.toContain("t3-pasted-image:");
  expect(output.match(/\.png\)/g)).toHaveLength(1);
  expect(output).toContain(" after");
  expect(pastedImageSendBlockReason([], source)).toContain("unavailable image");
  expect(() => appendPastedImagesToPrompt(source, [])).toThrow("unavailable image");
  expect(pastedImageSendBlockReason([{ ...image, status: "queued" }], source)).toContain("Wait");
});
