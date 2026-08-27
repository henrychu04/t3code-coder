import { describe, expect, it } from "vite-plus/test";

import { hasDismissedResumeCompaction, shouldOfferResumeCompaction } from "./claudeCompaction";

describe("Claude resume compaction", () => {
  it("offers compaction only for old, large Claude sessions", () => {
    const now = "2026-08-27T12:00:00.000Z";
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 120_000,
        updatedAt: "2026-08-27T10:45:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 99_999,
        updatedAt: "2026-08-27T10:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "codex",
        usedTokens: 120_000,
        updatedAt: "2026-08-27T10:00:00.000Z",
        now,
      }),
    ).toBe(false);
  });

  it("handles the exact age/token boundaries and invalid timestamps", () => {
    const now = "2026-08-27T12:00:00.000Z";
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-27T10:50:00.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-27T10:50:00.001Z",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "invalid",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-27T13:00:00.000Z",
        now,
      }),
    ).toBe(false);
  });

  it("recognizes the permanent dismissal response", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 1h 15m old and uses 120,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("does not mistake unrelated or malformed answers for permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is old. Compact it?": "Don't ask again",
            },
          },
        },
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 1h 15m old and uses 120,000 tokens. Compact it before continuing?":
                "Keep full history",
            },
          },
        },
        { kind: "user-input.resolved", payload: { answers: [] } },
      ]),
    ).toBe(false);
  });
});
