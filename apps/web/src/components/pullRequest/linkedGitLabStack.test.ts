import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { linkedGitLabStack } from "./linkedGitLabStack";

const link = (
  number: number,
  head: string,
  base: string,
  host = "gitlab.example",
): ThreadPullRequestLink => ({
  host,
  repository: "group/repo",
  number,
  url: `https://${host}/group/repo/-/merge_requests/${number}`,
  source: "manual",
  linkedAt: "2026-09-10T00:00:00.000Z",
  stack: null,
  snapshot: {
    state: "open",
    title: `MR ${number}`,
    headBranch: head,
    baseBranch: base,
    isDraft: false,
    updatedAt: "2026-09-10T00:00:00.000Z",
    syncedAt: "2026-09-10T00:00:00.000Z",
  },
});

describe("linked GitLab stack navigation", () => {
  it("orders a chain from base to tip and identifies the selected layer", () => {
    const links = [link(3, "c", "b"), link(1, "a", "main"), link(2, "b", "a")];
    const stack = linkedGitLabStack(links, links[2]!.url);
    expect(stack?.layers.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(stack?.position).toBe(2);
  });
  it("does not combine matching branches across hosts or repositories", () => {
    const first = link(1, "a", "main");
    const elsewhere = link(2, "b", "a", "elsewhere.example");
    expect(linkedGitLabStack([first, elsewhere], first.url)).toBeNull();
    expect(
      linkedGitLabStack(
        [
          first,
          {
            ...elsewhere,
            host: first.host,
            repository: "other/repo",
            url: "https://gitlab.example/other/repo/-/merge_requests/2",
          },
        ],
        first.url,
      ),
    ).toBeNull();
  });
  it("rejects unsupported or mismatched URLs and hides single or dismissed links", () => {
    const first = link(1, "a", "main");
    const second = link(2, "b", "a");
    expect(linkedGitLabStack([first], first.url)).toBeNull();
    expect(
      linkedGitLabStack(
        [first, { ...second, url: "https://github.com/group/repo/pull/2" }],
        first.url,
      ),
    ).toBeNull();
    expect(linkedGitLabStack([first, { ...second, url: first.url }], first.url)).toBeNull();
    expect(
      linkedGitLabStack([first, { ...second, source: "stack-dismissed" }], first.url),
    ).toBeNull();
  });
  it("does not guess a parent when linked MRs reuse a head branch", () => {
    const links = [link(1, "a", "main"), link(2, "a", "main"), link(3, "b", "a")];
    expect(linkedGitLabStack(links, links[2]!.url)).toBeNull();
  });
});
