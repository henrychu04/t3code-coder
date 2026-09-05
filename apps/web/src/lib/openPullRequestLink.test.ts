import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForGitLabMergeRequest,
  matchesLinkedPullRequestUrl,
  parseGitLabMergeRequestUrl,
  gitLabAuthorProfileUrl,
  gitLabMergeRequestBrowserUrl,
  changeRequestRepositoryUrl,
} from "./openPullRequestLink";

describe("GitLab merge request links", () => {
  it("adapts profile and fallback links to a self-hosted GitLab path prefix", () => {
    const url = "https://code.example:8443/gitlab/group/nested/project/-/merge_requests/42";
    expect(gitLabAuthorProfileUrl(url, "group/nested/project", "author.name")).toBe(
      "https://code.example:8443/gitlab/author.name",
    );
    expect(gitLabAuthorProfileUrl(url, "wrong/project", "author")).toBeNull();
    expect(gitLabAuthorProfileUrl(url, "group/nested/project", "../admin")).toBeNull();
    expect(
      gitLabAuthorProfileUrl(
        "https://secret@code.example/group/project/-/merge_requests/1",
        "group/project",
        "author",
      ),
    ).toBeNull();
    const identity = {
      provider: "gitlab" as const,
      canonicalKey: "code.example/group/nested/project",
      displayName: "group/nested/project",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://code.example:8443/gitlab/group/nested/project.git",
      },
    };
    expect(gitLabMergeRequestBrowserUrl(identity, "group/nested/project", 42)).toBe(url);
    expect(
      gitLabMergeRequestBrowserUrl({ ...identity, provider: "github" }, "group/nested/project", 42),
    ).toBeNull();
    expect(gitLabMergeRequestBrowserUrl(identity, "group/../project", 42)).toBeNull();
    expect(changeRequestRepositoryUrl("https://github.com/group/project/pull/42")).toBeNull();
  });
  it("parses nested GitLab repositories", () => {
    expect(
      parseGitLabMergeRequestUrl(
        "https://gitlab.example.com/group/platform/project/-/merge_requests/42/diffs",
      ),
    ).toEqual({
      host: "gitlab.example.com",
      repository: "group/platform/project",
      number: 42,
    });
  });

  it("matches the link to the Coder environment holding that repository", () => {
    const link = parseGitLabMergeRequestUrl(
      "https://gitlab.example.com/group/project/-/merge_requests/42",
    )!;
    const project = {
      id: ProjectId.make("project-1"),
      environmentId: EnvironmentId.make("environment-1"),
      repositoryIdentity: {
        canonicalKey: "gitlab.example.com/group/project",
        displayName: "group/project",
        provider: "gitlab" as const,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@gitlab.example.com:group/project.git",
        },
      },
    };

    expect(findProjectForGitLabMergeRequest([project], link)).toBe(project);
  });

  it("matches a durable linked MR by host, repository, and number", () => {
    expect(
      matchesLinkedPullRequestUrl(
        {
          projectId: ProjectId.make("project-1"),
          repository: "group/project",
          number: 42,
          url: "https://gitlab.example.com/group/project/-/merge_requests/42",
        },
        "https://gitlab.example.com/group/project/-/merge_requests/42/diffs",
      ),
    ).toBe(true);
    expect(
      matchesLinkedPullRequestUrl(
        {
          projectId: ProjectId.make("project-1"),
          repository: "group/project",
          number: 42,
          url: "https://gitlab.example.com/group/project/-/merge_requests/42",
        },
        "https://gitlab.example.com/group/project/-/merge_requests/43",
      ),
    ).toBe(false);
  });
});
