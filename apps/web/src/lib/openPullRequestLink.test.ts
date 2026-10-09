import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestRepositoryUrl,
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  gitHubPullRequestBrowserUrl,
  gitLabMergeRequestBrowserUrl,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  shouldOpenPullRequestExternally,
} from "./openPullRequestLink";
import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { parseChangeRequestUrl as parseHostedChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

function repositoryIdentity(
  provider: string,
  canonicalKey: string,
  remoteUrl: string,
): RepositoryIdentity {
  return {
    canonicalKey,
    provider,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  };
}

describe("gitHubPullRequestBrowserUrl", () => {
  it("uses the requested GitHub repository instead of the project's default repository", () => {
    const identity = repositoryIdentity(
      "github",
      "github.com/acme/default",
      "https://github.com/acme/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("preserves a custom GitHub HTTP origin without its credentials", () => {
    const identity = repositoryIdentity(
      "github",
      "github.acme.test/team/default",
      "http://token@github.acme.test:8443/team/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 7)).toBe(
      "http://github.acme.test:8443/platform/api/pull/7",
    );
  });

  it.each([
    {
      name: "SSH",
      remoteUrl: "git@github.acme.test:team/default.git",
    },
    {
      name: "git protocol",
      remoteUrl: "git://github.acme.test/team/default.git",
    },
  ])("uses the normalized host for a $name remote", ({ remoteUrl }) => {
    const identity = repositoryIdentity("github", "github.acme.test/team/default", remoteUrl);

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 9)).toBe(
      "https://github.acme.test/platform/api/pull/9",
    );
  });

  it("returns null for missing or invalid GitHub data", () => {
    expect(gitHubPullRequestBrowserUrl(null, "acme/repository", 1)).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "../repository",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme/repository",
        0,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "bad host/acme/repository", "not a remote"),
        "acme/repository",
        1,
      ),
    ).toBeNull();
  });

  it.each(["gitlab", "bitbucket", "azure-devops", "unknown"])(
    "does not build a fallback for %s",
    (provider) => {
      expect(
        gitHubPullRequestBrowserUrl(
          repositoryIdentity(provider, "github.com/acme/repository", "https://github.com/a/b"),
          "acme/repository",
          1,
        ),
      ).toBeNull();
    },
  );
});

describe("changeRequestRepositoryUrl", () => {
  it("preserves repository path casing", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/Team/Platform/Repo/-/merge_requests/42/diffs#note_1",
      ),
    ).toBe("https://gitlab.example.test/Team/Platform/Repo");
  });

  it("keeps pull-like segments inside nested GitLab repository paths", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/group/pull/123/repo/-/merge_requests/42",
      ),
    ).toBe("https://gitlab.example.test/group/pull/123/repo");
  });
});

describe("pullRequestCandidateUrlFromReferenceAutolink", () => {
  it("turns GitHub's shared issue route into a pull request candidate", () => {
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://github.com/pingdotgg/t3code/issues/8600#issuecomment-1",
      ),
    ).toBe("https://github.com/pingdotgg/t3code/pull/8600#issuecomment-1");
  });

  it("does not reinterpret other issue hosts or malformed references", () => {
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://gitlab.com/pingdotgg/t3code/-/issues/8600",
      ),
    ).toBeNull();
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://github.com/pingdotgg/t3code/issues/not-a-number",
      ),
    ).toBeNull();
  });
});

describe("matchesLinkedPullRequestUrl", () => {
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };

  it("matches the same pull request without looking up its project", () => {
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.com/PingDotGG/T3Code/pull/42/files",
      ),
    ).toBe(true);
  });

  it.each([
    ["http://forge.example:3000/git/team/repo/pulls/42/files", true],
    ["http://forge.example:4000/git/team/repo/pulls/42", false],
    ["http://forge.example/git/team/repo/pulls/42", false],
  ])("matches Forgejo links by web authority: %s", (url, expected) => {
    expect(
      matchesLinkedPullRequestUrl(
        { ...linkedPullRequest, url: "http://forge.example:3000/git/team/repo/pulls/42" },
        url,
      ),
    ).toBe(expected);
  });

  it("keeps other providers' existing port normalization", () => {
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.com:8443/pingdotgg/t3code/pull/42",
      ),
    ).toBe(true);
  });

  it("keeps Forgejo and GitHub path shapes distinct on a GitHub-named host", () => {
    expect(
      matchesLinkedPullRequestUrl(
        { ...linkedPullRequest, url: "https://github.internal/team/repo/pulls/42" },
        "https://github.internal/team/repo/pull/42",
      ),
    ).toBe(false);
  });

  it("rejects a different pull request or host", () => {
    expect(
      matchesLinkedPullRequestUrl(linkedPullRequest, "https://github.com/pingdotgg/t3code/pull/43"),
    ).toBe(false);
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.example.com/pingdotgg/t3code/pull/42",
      ),
    ).toBe(false);
  });
});

describe("shouldOpenPullRequestExternally", () => {
  it("uses the browser for command-click and control-click", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("keeps an unmodified click in the pull request view", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

// The shared parser recognises every hosted provider; the web lib narrows it to GitLab below.
describe("parseHostedChangeRequestUrl", () => {
  it("reads a GitHub pull request", () => {
    expect(parseHostedChangeRequestUrl("https://github.com/T3Tools/T3Code/pull/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseHostedChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a GitLab merge request, nested groups and all", () => {
    expect(
      parseHostedChangeRequestUrl("https://gitlab.com/t3tools/platform/t3code/-/merge_requests/42"),
    ).toEqual({
      host: "gitlab.com",
      repository: "t3tools/platform/t3code",
      number: 42,
    });
  });

  it("reads a merge request on a self-hosted GitLab named nothing like GitLab", () => {
    expect(
      parseHostedChangeRequestUrl("https://code.acme.test/team/project/-/merge_requests/9"),
    ).toEqual({
      host: "code.acme.test",
      repository: "team/project",
      number: 9,
    });
  });

  it("reads a Bitbucket pull request", () => {
    expect(
      parseHostedChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5"),
    ).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
  });

  it("reads both Azure DevOps URL forms, keeping `_git` in the repository path", () => {
    expect(
      parseHostedChangeRequestUrl("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17"),
    ).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform/_git/t3code",
      number: 17,
    });
    expect(
      parseHostedChangeRequestUrl(
        "https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17",
      ),
    ).toEqual({
      host: "acme.visualstudio.com",
      repository: "platform/_git/t3code",
      number: 17,
    });
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(
      parseHostedChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/files?w=1"),
    ).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(
      parseHostedChangeRequestUrl(
        "https://gitlab.com/team/project/-/merge_requests/42/diffs#note_1",
      ),
    ).toEqual({ host: "gitlab.com", repository: "team/project", number: 42 });
    expect(
      parseHostedChangeRequestUrl("https://bitbucket.org/team/repo/pull-requests/5/commits"),
    ).toEqual({ host: "bitbucket.org", repository: "team/repo", number: 5 });
    expect(parseHostedChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of, so the link goes to the browser", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/issues/123",
      "https://github.com/t3tools/t3code/commit/0a1b2c3",
      "https://github.com/t3tools/t3code",
      "https://github.com/t3tools/t3code/pull/abc",
      "https://gitlab.com/t3tools/t3code/-/snippets/12",
      "https://gitlab.com/t3tools/t3code/-/issues/12",
      // A path shape that means nothing off its own host.
      "https://blog.example.test/2026/updates/pull/3",
      // A lookalike is deliberately not fought here: `github.com.evil.test` reads as a GitHub
      // Enterprise install and there is no way to tell it from one. It is `findProjectForChange
      // Request` that refuses it, because no project in the workspace is checked out from it.
      "javascript:alert(1)//github.com/t3tools/t3code/pull/1",
      "not a url",
    ]) {
      expect(parseHostedChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;
  // Coder: GitLab fixtures; other providers' checkouts never resolve a link.
  const frontend = project("frontend", {
    canonicalKey: "gitlab.com/acme/frontend",
    provider: "gitlab",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "gitlab.com/acme/backend",
    provider: "gitlab",
    owner: "acme",
    name: "backend",
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost([frontend, backend], {
        host: "gitlab.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(backend);
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "gitlab.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(frontend);
  });

  it("finds nothing on a host nothing is checked out from", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "code.example",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBeUndefined();
  });
});

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    // The server identifies a repository by `displayName`, which keeps every group segment; the
    // two-segment owner/name form would look for `t3tools/t3code` and find nothing.
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: "gitlab",
        displayName: "t3tools/platform/t3code",
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "gitlab.com",
        repository: "t3tools/platform/t3code",
        number: 42,
      }),
    ).toBe(projects[0]);
  });

  it("keeps two hosts apart, so an Enterprise link does not open the public one", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.acme.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.com-evil.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });
});

// Coder: merge requests resolve only through GitLab checkouts, and fallback links keep a
// self-hosted install's origin and path prefix.
describe("GitLab seams", () => {
  it("builds fallback merge request links under a self-hosted path prefix", () => {
    const url = "https://code.example:8443/gitlab/group/nested/project/-/merge_requests/42";
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
  });

  it("never resolves a link through a checkout from another provider", () => {
    const github = {
      id: "github",
      repositoryIdentity: repositoryIdentity(
        "github",
        "gitlab.example.com/group/project",
        "https://gitlab.example.com/group/project.git",
      ),
    } as never;
    const link = parseChangeRequestUrl(
      "https://gitlab.example.com/group/project/-/merge_requests/42",
    )!;
    expect(findProjectForChangeRequest([github], link)).toBeUndefined();
    expect(findProjectOnChangeRequestHost([github], link)).toBeUndefined();
  });

  it("matches a self-hosted checkout whose provider could not be named", () => {
    const checkout = {
      id: "unknown",
      repositoryIdentity: {
        ...repositoryIdentity(
          "unknown",
          "code.example/team/frontend",
          "https://code.example/team/frontend.git",
        ),
        displayName: "team/frontend",
      },
    } as never;
    const url = "https://code.example/team/backend/-/merge_requests/42";
    expect(findProjectOnChangeRequestHost([checkout], parseChangeRequestUrl(url)!)).toBe(checkout);
    expect(
      findProjectOnChangeRequestHost(
        [checkout],
        parseChangeRequestUrl(url.replace("code.example", "unknown.example"))!,
      ),
    ).toBeUndefined();
  });

  it("treats only GitLab merge request URLs as change requests", () => {
    expect(
      parseChangeRequestUrl("https://code.example/group/project/-/merge_requests/42/diffs"),
    ).toEqual({ host: "code.example", repository: "group/project", number: 42 });
    for (const url of [
      "https://github.com/acme/web/pull/42",
      "https://bitbucket.org/acme/web/pull-requests/42",
      "https://forge.example/acme/web/pulls/42",
    ]) {
      expect(parseChangeRequestUrl(url)).toBeNull();
    }
  });
});
