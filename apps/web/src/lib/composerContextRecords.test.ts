import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";

import {
  formatInlineContextReference,
  removeInlineContextReference,
} from "./composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isPullRequestSummaryContext,
  isSameComposerContextPayload,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  resolveUserMessageContext,
  selectedMessageContextFragment,
  reviewCommentContextLabel,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextRecord,
  terminalContextReference,
  terminalContextDraftFromRecord,
  uploadedAttachmentContextRecord,
} from "./composerContextRecords";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

describe("composerContextRecords", () => {
  it("copies only ready or persisted server-side attachment IDs", () => {
    const environmentId = EnvironmentId.make("env");
    const image = {
      type: "image" as const,
      id: "local-image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    expect(uploadedAttachmentContextRecord(image, undefined)).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, { status: "uploading", environmentId, progress: 0.5 }),
    ).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, {
        status: "failed",
        environmentId,
        reason: "offline",
        attachmentId: "unfinished",
      }),
    ).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, {
        status: "ready",
        environmentId,
        attachmentId: "uploaded-image",
      }),
    ).toMatchObject({ attachmentId: "uploaded-image", contextId: "image_local-image" });
    const file = {
      type: "file" as const,
      id: "local-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    expect(uploadedAttachmentContextRecord(file, undefined)).toBeNull();
    expect(
      uploadedAttachmentContextRecord(
        { ...file, uploadedAttachmentId: "persisted-file", uploadEnvironmentId: environmentId },
        undefined,
      ),
    ).toMatchObject({ attachmentId: "persisted-file", contextId: "file_local-file" });
  });
  it.each(["x", "terminal_x"])(
    "preserves canonical terminal IDs across repeated imports: %s",
    (id) => {
      const threadId = ThreadId.make("t1");
      const record = terminalContextRecord({
        id,
        threadId,
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        text: "output",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const restored = terminalContextRecord(terminalContextDraftFromRecord(record, threadId));
      expect(restored).toEqual(record);
      expect(terminalContextRecord(terminalContextDraftFromRecord(restored, threadId))).toEqual(
        record,
      );
    },
  );

  it.each(["x", "review-comment_x"])("preserves canonical review IDs across imports: %s", (id) => {
    const record = reviewCommentContextRecord({
      id,
      sectionId: "s",
      sectionTitle: "Review",
      filePath: "a.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Review",
      diff: "",
    });
    expect(reviewCommentContextRecord(reviewCommentFromRecord(record))).toEqual(record);
  });

  it.each([
    ["+181", "a.ts L181"],
    ["+181 to +183", "a.ts L181 to L183"],
    ["-63", "a.ts L63 (before)"],
    ["L4", "a.ts L4"],
  ])("presents review range %s consistently as %s", (rangeLabel, expected) => {
    expect(
      reviewCommentContextLabel({
        id: "review-1",
        sectionId: "file:src/a.ts",
        sectionTitle: "File comment",
        filePath: "src/a.ts",
        startIndex: 0,
        endIndex: 0,
        rangeLabel,
        text: "",
        diff: "",
      }),
    ).toBe(expected);
  });

  it("distinguishes a PR summary from a comment on its diff", () => {
    const summary = {
      id: "review-1",
      sectionId: "pull-request:42",
      sectionTitle: "PR #42",
      filePath: "PR #42",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "Improve context chips",
      text: "Pull request details",
      diff: "",
      pullRequest: {
        number: 42,
        title: "Improve context chips",
        url: "https://github.com/pingdotgg/t3code/pull/42",
        headBranch: "feat/context-chips",
        baseBranch: "main",
        state: "open" as const,
        isDraft: false,
      },
    };

    expect(isPullRequestSummaryContext(summary)).toBe(true);
    expect(reviewCommentContextLabel(summary)).toBe("#42");
    expect(pullRequestContextDisplayState(summary)).toBe("open");
    expect(pullRequestContextKindLabel(summary)).toBe("Open pull request");
    expect(
      pullRequestContextDisplayState({
        ...summary,
        pullRequest: { ...summary.pullRequest, isDraft: true },
      }),
    ).toBe("draft");
    expect(
      isPullRequestSummaryContext({
        ...summary,
        pullRequest: undefined,
        filePath: "src/a.ts",
        rangeLabel: "+12",
        diff: "+const answer = 42;",
      }),
    ).toBe(false);
  });

  it("removes an expired terminal chip by its kind-scoped id, not the producer id", () => {
    const context = {
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "boom",
    };
    const reference = terminalContextReference(context);
    expect(reference.contextId).toBe("terminal_term-1");

    const prompt = `prose ${formatInlineContextReference(reference)} tail`;
    // The send path drops expired excerpts; the raw producer id matches nothing and would
    // leave the chip behind.
    expect(removeInlineContextReference(prompt, context.id).prompt).toBe(prompt);
    expect(removeInlineContextReference(prompt, reference.contextId).prompt).toBe("prose tail");
  });

  it("clamps an oversized review selection so the record still encodes", () => {
    const build = (diffLength: number) =>
      reviewCommentContextRecord({
        id: "rc-big",
        sectionId: "file:a/b.ts",
        sectionTitle: "File comment",
        filePath: "a/b.ts",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "L1",
        text: "Why?",
        diff: "d".repeat(diffLength),
      });

    // At the limit the diff is untouched; one character over it is clamped, and both encode.
    const atLimit = build(32_000);
    expect(atLimit.diff).toHaveLength(32_000);
    const overLimit = build(32_001);
    expect(overLimit.diff.length).toBeLessThanOrEqual(32_000);
    expect(overLimit.diff.endsWith("… truncated …")).toBe(true);
    expect(() => decodeMessageContext({ version: 1, records: [atLimit] })).not.toThrow();
    expect(() => decodeMessageContext({ version: 1, records: [overLimit] })).not.toThrow();
  });

  it("treats colliding ids with different payloads as distinct records", () => {
    const base = terminalContextRecord({
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "A",
    });
    expect(isSameComposerContextPayload(base, { ...base })).toBe(true);
    // Labels are display text, never identity.
    expect(isSameComposerContextPayload(base, { ...base, label: "different" })).toBe(true);
    expect(isSameComposerContextPayload(base, { ...base, text: "B" })).toBe(false);
  });

  it("finds the destination collision for different legacy terminal messages", () => {
    const legacy = (text: string) =>
      asKnownContextRecord(
        upgradeLegacyContextMessage(
          `Inspect this\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | ${text}\n</terminal_context>`,
        ).records[0],
      )!;
    const first = legacy("A");
    const second = legacy("B");
    if (first.kind !== "terminal" || second.kind !== "terminal") {
      throw new Error("Expected legacy terminal records");
    }
    const destinationId = terminalContextReference(
      terminalContextDraftFromRecord(first, ThreadId.make("t")),
    ).contextId;

    expect(destinationId).toBe("terminal_legacy_terminal_1");
    expect(composerContextImportLookupIds(second)[0]).toBe(destinationId);
    expect(isSameComposerContextPayload(first, second)).toBe(false);
  });

  it("treats an imported legacy id and its canonical reconstruction as the same excerpt", () => {
    const draft = {
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "A",
    };
    const canonical = terminalContextRecord(draft);
    // An import carries the id it was sent with; the draft rebuilds the folded
    // canonical form. Same payload either way, so no duplicate entry may form.
    const imported = { ...canonical, contextId: "legacy_terminal_1" as ComposerContextId };

    expect(isSameComposerContextPayload(canonical, imported)).toBe(true);
    expect(isSameComposerContextPayload(canonical, { ...canonical, text: "B" })).toBe(false);
  });

  it("resolves structured context directly and upgrades legacy text otherwise", () => {
    const structured = resolveUserMessageContext({
      text: "hi [b.ts L4](t3-context://v1/review-comment/rc-1)",
      context: {
        version: 1,
        records: [
          reviewCommentContextRecord({
            id: "rc-1",
            sectionId: "s",
            sectionTitle: "t",
            filePath: "a/b.ts",
            startIndex: 3,
            endIndex: 3,
            rangeLabel: "L4",
            text: "",
            diff: "",
          }),
        ],
      },
    });
    expect(structured.recordsById.get("review-comment_rc-1")?.kind).toBe("review-comment");
    const legacy = resolveUserMessageContext({
      text: "hi\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>",
    });
    expect(legacy.text).toBe("hi\n\n[T line 1](t3-context://v1/terminal/legacy_terminal_1)");
    expect(legacy.recordsById.get("legacy_terminal_1")?.kind).toBe("terminal");
  });
});

describe("attachment context records", () => {});

describe("producer ids that do not fit the grammar", () => {
  it("folds review comment ids and keeps the raw id in the draft shape", () => {
    const record = reviewCommentContextRecord({
      id: "pull-request-finding:42",
      sectionId: "s",
      sectionTitle: "t",
      filePath: "a/b.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "",
      diff: "",
    });
    expect(record.contextId).toMatch(/^review-comment_pull-request-finding-42-[0-9a-f]{16}$/);
    expect(
      resolveUserMessageContext({
        text: `[b.ts L1](t3-context://v1/review-comment/${record.contextId})`,
        context: { version: 1, records: [record] },
      }).recordsById.has(record.contextId),
    ).toBe(true);
  });
});

describe("selectedMessageContextFragment", () => {
  const terminal = terminalContextRecord({
    id: "term-1",
    threadId: ThreadId.make("t"),
    createdAt: "2026-01-01T00:00:00.000Z",
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "A",
  });
  const review = reviewCommentContextRecord({
    id: "rc-1",
    sectionId: "s",
    sectionTitle: "t",
    filePath: "a/b.ts",
    startIndex: 3,
    endIndex: 3,
    rangeLabel: "L4",
    text: "",
    diff: "",
  });
  const input = {
    records: [terminal, review],
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("t"),
    messageId: MessageId.make("msg-1"),
  };

  it("carries only records for chips inside the selection", () => {
    const fragment = selectedMessageContextFragment({
      ...input,
      markdown: `see [b.ts L4](t3-context://v1/review-comment/${review.contextId})`,
    });

    expect(fragment).toContain(review.contextId);
    expect(fragment).not.toContain(terminal.contextId);
  });

  it("returns null when no selected chip has backing records", () => {
    expect(selectedMessageContextFragment({ ...input, markdown: "just prose" })).toBeNull();
    expect(
      selectedMessageContextFragment({
        ...input,
        records: [],
        markdown: `[b.ts L4](t3-context://v1/review-comment/${review.contextId})`,
      }),
    ).toBeNull();
  });
});
