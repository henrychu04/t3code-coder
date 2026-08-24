import { describe, expect, it } from "@effect/vitest";

import { buildGeneratedWorktreeBranchName } from "./git.ts";

describe("buildGeneratedWorktreeBranchName", () => {
  it("normalizes generated labels under the T3 worktree prefix", () => {
    expect(buildGeneratedWorktreeBranchName("refs/heads/T3Code/Fix Reconnect")).toBe(
      "t3code/fix-reconnect",
    );
  });

  it("uses a safe fallback for an empty generated label", () => {
    expect(buildGeneratedWorktreeBranchName("  ...  ")).toBe("t3code/update");
  });
});
