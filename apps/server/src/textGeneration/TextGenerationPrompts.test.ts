import { describe, expect, it } from "vite-plus/test";

import { buildCommitMessagePrompt, buildPrContentPrompt } from "./TextGenerationPrompts.ts";

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
