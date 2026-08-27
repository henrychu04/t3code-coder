import { describe, expect, it } from "vite-plus/test";

import {
  formatClaudeResumeCompactionQuestion,
  isClaudeResumeCompactionQuestion,
} from "./claudeCompaction.ts";

describe("Claude resume compaction questions", () => {
  it("formats minute and hour ages deterministically", () => {
    expect(formatClaudeResumeCompactionQuestion({ ageMinutes: 59, estimatedTokens: 99_999 })).toBe(
      "This session is 59m old and uses 99,999 tokens. Compact it before continuing?",
    );
    expect(formatClaudeResumeCompactionQuestion({ ageMinutes: 60, estimatedTokens: 100_000 })).toBe(
      "This session is 1h 0m old and uses 100,000 tokens. Compact it before continuing?",
    );
  });

  it("matches only canonical generated questions", () => {
    const question = formatClaudeResumeCompactionQuestion({
      ageMinutes: 135,
      estimatedTokens: 1_000_000,
    });
    expect(isClaudeResumeCompactionQuestion(question)).toBe(true);
    expect(isClaudeResumeCompactionQuestion(`${question} `)).toBe(false);
    expect(isClaudeResumeCompactionQuestion(question.replace("1,000,000", "1000000"))).toBe(false);
  });
});
