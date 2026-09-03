import type { VcsStatusLocalResult, VcsStatusRemoteResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { automaticPullSkipReason } from "./projectAutoPull.ts";

const local = {
  isRepo: true,
  isDefaultRef: true,
  hasWorkingTreeChanges: false,
} as VcsStatusLocalResult;

const remote = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 1,
} as VcsStatusRemoteResult;

describe("automaticPullSkipReason", () => {
  it("allows only a clean, behind default branch with an upstream", () => {
    expect(automaticPullSkipReason(local, remote)).toBeNull();
    expect(automaticPullSkipReason({ ...local, isRepo: false }, remote)).toBe(
      "not-a-repository",
    );
    expect(automaticPullSkipReason({ ...local, isDefaultRef: false }, remote)).toBe(
      "not-on-default-branch",
    );
    expect(automaticPullSkipReason(local, null)).toBe("no-upstream");
    expect(automaticPullSkipReason(local, { ...remote, hasUpstream: false })).toBe("no-upstream");
    expect(automaticPullSkipReason({ ...local, hasWorkingTreeChanges: true }, remote)).toBe(
      "working-tree-changes",
    );
    expect(automaticPullSkipReason(local, { ...remote, aheadCount: 1 })).toBe("local-commits");
    expect(automaticPullSkipReason(local, { ...remote, behindCount: 0 })).toBe("already-current");
  });
});
