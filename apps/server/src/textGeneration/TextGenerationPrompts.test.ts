import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
} from "./TextGenerationPrompts.ts";

describe("source control writing policies", () => {
  it("adds bounded commit instructions", () => {
    const { prompt } = buildCommitMessagePrompt({
      branch: "feature/panel",
      stagedSummary: "panel.ts",
      stagedPatch: "+panel",
      policy: { commitInstructions: "Use Conventional Commits." },
    });
    expect(prompt).toContain("Additional instructions:\nUse Conventional Commits.");
  });

  it("adds merge request instructions while retaining templates", () => {
    const { prompt } = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/panel",
      commitSummary: "restore panel",
      diffSummary: "1 file changed",
      diffPatch: "+panel",
      changeRequestTemplate: "## Checklist",
      policy: { changeRequestInstructions: "Keep the title concise." },
    });
    expect(prompt).toContain("Keep the title concise.");
    expect(prompt).toContain("Repository merge request template:\n## Checklist");
  });
});

describe("buildBranchNamePrompt naming", () => {
  it("requests a semantic prefix as part of the same branch response", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add search",
      naming: { mode: "semantic", prefix: "ignored", instructions: "ignored instruction" },
    });
    expect(prompt).toContain("feat/add-search");
    expect(prompt).not.toContain("ignored instruction");
  });
  it("appends custom instructions without imposing a prefix, case or word limit", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add search",
      naming: {
        mode: "custom",
        prefix: "ignored",
        instructions: "Use Julius/ABC-123 and preserve capitalization.",
      },
    });
    expect(prompt).toContain("Use Julius/ABC-123 and preserve capitalization.");
    expect(prompt).toContain("complete branch name");
    expect(prompt).not.toContain("2-6 words");
    expect(prompt).not.toContain("lowercase");
  });
  it("asks for just the fragment in static mode", () => {
    const { prompt } = buildBranchNamePrompt({
      message: "Add search",
      naming: { mode: "static", prefix: "team", instructions: "ignored instruction" },
    });
    expect(prompt).toContain("without a prefix or namespace");
    expect(prompt).not.toContain("ignored instruction");
  });
});
