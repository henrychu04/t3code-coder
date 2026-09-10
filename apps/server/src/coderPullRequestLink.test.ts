import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { isCoderPullRequestLink } from "./coderPullRequestLink.ts";

const projects = [
  {
    repositoryIdentity: {
      provider: "gitlab",
      canonicalKey: "code.example/team/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://code.example/team/repo.git",
      },
    },
  },
] as OrchestrationProjectShell[];
const link = {
  host: "code.example",
  repository: "team/repo",
  number: 42,
  url: "https://code.example/team/repo/-/merge_requests/42",
};
describe("Coder MR links", () => {
  it("accepts a matching link on an established GitLab host, including another repository", () => {
    expect(isCoderPullRequestLink(link, projects)).toBe(true);
    expect(
      isCoderPullRequestLink(
        {
          ...link,
          repository: "other/group/repo",
          url: "https://code.example/other/group/repo/-/merge_requests/42",
        },
        projects,
      ),
    ).toBe(true);
  });
  it.each([
    {
      ...link,
      host: "unknown.example",
      url: "https://unknown.example/team/repo/-/merge_requests/42",
    },
    { ...link, number: 43 },
    { ...link, repository: "other/repo" },
    { ...link, url: "https://code.example/team/repo/pull/42" },
    { ...link, url: "https://user:secret@code.example/team/repo/-/merge_requests/42" },
    { ...link, url: "not a URL" },
  ])("rejects an untrusted or inconsistent reference %#", (candidate) => {
    expect(isCoderPullRequestLink(candidate, projects)).toBe(false);
  });
  it("does not trust a host without GitLab metadata", () => {
    expect(isCoderPullRequestLink(link, [])).toBe(false);
    expect(
      isCoderPullRequestLink(link, [
        {
          ...projects[0],
          repositoryIdentity: { ...projects[0]!.repositoryIdentity!, provider: "unknown" },
        } as OrchestrationProjectShell,
      ]),
    ).toBe(false);
  });
});
