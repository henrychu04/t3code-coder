import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dedupeChecks } from "./pullRequestChecks.ts";

function entry(workflowName: string | null, name: string, status: PullRequestCheckStatus) {
  return {
    workflowName,
    at: null,
    check: { name, status, description: null, url: null } satisfies PullRequestCheck,
  };
}

describe("dedupeChecks", () => {
  it("does not merge distinct workflow and check pairs whose space-joined names collide", () => {
    const checks = dedupeChecks([entry("a", "b c", "success"), entry("a b", "c", "failure")]);

    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["b c", "success"],
      ["c", "failure"],
    ]);
  });
});
