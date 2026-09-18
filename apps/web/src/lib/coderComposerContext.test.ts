import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { encodeCoderComposerContext, decodeCoderComposerContext } from "./coderComposerContext";
import { imageContextReference, longTextContextReference } from "./composerInlineContext";
import { buildPullRequestReferenceContext } from "../components/pullRequest/pullRequestDetail.logic";
import {
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
} from "../reviewCommentContext";
const terminal = {
  id: "terminal-1",
  threadId: ThreadId.make("thread-1"),
  terminalId: "term",
  terminalLabel: "Terminal",
  lineStart: 1,
  lineEnd: 2,
  text: "output",
  createdAt: "2026-01-01T00:00:00Z",
};
const metadata = {
  number: 42,
  title: 'Fix "quotes" & <tags>',
  url: "https://gitlab.com/team/repo/-/merge_requests/42",
  headBranch: "fix",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
};
describe("Coder context adapter", () => {
  it("round-trips mixed context, unicode and offsets around every chip", () => {
    const sources = [
      imageContextReference("00000000-0000-4000-8000-000000000001"),
      longTextContextReference("long 😃 text\nwith @file and #42"),
      formatReviewCommentContext(buildPullRequestReferenceContext(metadata)),
      "\uFFFC",
    ];
    const value = "Before 雪 " + sources.join(" between ") + " after";
    const offsets = [0, value.length];
    for (const source of sources) {
      const at = value.indexOf(source);
      offsets.push(at, at + source.length);
    }
    for (const offset of offsets) {
      const encoded = encodeCoderComposerContext(value, [terminal], offset);
      expect(collectComposerContextReferences(encoded.value)).toHaveLength(4);
      expect(decodeCoderComposerContext(encoded.value, encoded.records, encoded.offset)).toEqual({
        value,
        offset,
        terminalContextIds: [terminal.id],
      });
    }
  });
  it("retains terminal identity when chips are reordered or removed", () => {
    const second = { ...terminal, id: "terminal-2" };
    const encoded = encodeCoderComposerContext("\uFFFC and \uFFFC", [terminal, second]);
    const references = collectComposerContextReferences(encoded.value);
    const next = references[1]!.source + " " + references[0]!.source;
    expect(decodeCoderComposerContext(next, encoded.records).terminalContextIds).toEqual([
      second.id,
      terminal.id,
    ]);
    expect(
      decodeCoderComposerContext(references[1]!.source, encoded.records).terminalContextIds,
    ).toEqual([second.id]);
  });
  it("preserves GitLab metadata across draft and sent-message parsing", () => {
    const source = formatReviewCommentContext(buildPullRequestReferenceContext(metadata));
    const segment = parseReviewCommentMessageSegments(source)[0];
    expect(segment?.kind === "review-comment" && segment.comment.pullRequest).toEqual(metadata);
    const encoded = encodeCoderComposerContext(source, []);
    expect(decodeCoderComposerContext(encoded.value, encoded.records).value).toBe(source);
  });
  it("keeps unknown references unresolved without reading or importing resources", () => {
    const value = "[unavailable](t3-context://v1/file/unknown)";
    expect(decodeCoderComposerContext(value, new Map()).value).toBe(value);
  });
});
