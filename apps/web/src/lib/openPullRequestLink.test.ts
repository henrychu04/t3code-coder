import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForGitLabMergeRequest,
  isGitLabExternalUrl,
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
      gitLabMergeRequestBrowserUrl(
        { ...identity, provider: "unknown" },
        "group/nested/project",
        42,
      ),
    ).toBe(url);
    expect(gitLabMergeRequestBrowserUrl(identity, "GROUP/nested/Project", 42)).toBe(
      "https://code.example:8443/gitlab/GROUP/nested/Project/-/merge_requests/42",
    );
    expect(gitLabMergeRequestBrowserUrl(identity, "wrong/project", 42)).toBeNull();
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

describe("external GitLab links", () => {
  const projects = [
    {
      repositoryIdentity: {
        provider: "gitlab" as const,
        canonicalKey: "code.example/group/project",
        displayName: "group/project",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@code.example:group/project.git",
        },
      },
    },
  ];
  it("recognizes GitLab.com and known self-hosted GitLab hosts", () => {
    expect(isGitLabExternalUrl("https://gitlab.com/explore", [])).toBe(true);
    expect(isGitLabExternalUrl("https://code.example/group/project/-/issues/1", projects)).toBe(
      true,
    );
    expect(isGitLabExternalUrl("http://code.example:8080/group/project", projects)).toBe(true);
    expect(isGitLabExternalUrl("https://code.example/group/project", [])).toBe(false);
    expect(
      isGitLabExternalUrl("https://code.example/group/project", [
        { repositoryIdentity: { ...projects[0]!.repositoryIdentity, provider: "unknown" } },
      ]),
    ).toBe(false);
  });
  it.each([
    "https://gitlab.com.evil.example/project",
    "https://gitlab.evil.example/project",
    "https://gitlab.com@evil.example/project",
    "https://user:secret@gitlab.com/project",
    "javascript:alert(1)",
    "ftp://gitlab.com/project",
    "//gitlab.com/project",
    "/group/project",
    "https://github.com/group/project",
    "https://example.com/group/project/-/merge_requests/1",
  ])("keeps unrecognized or unsafe URLs inert: %s", (url) => {
    expect(isGitLabExternalUrl(url, projects)).toBe(false);
  });
});
