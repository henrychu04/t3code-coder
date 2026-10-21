// Coder: upstream's cases for the GitLab-only registry; other hosts' URLs are rejected.
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

import { parsePullRequestReference, resolveLinkPullRequestInput } from "./pullRequestLinkInput.ts";

const changeRequestWebUrl = (kind: string, host: string, repository: string, number: number) =>
  sourceControlClients.get(kind).changeRequestUrl({ host, repository, number });

const project = {
  host: "gitlab.com",
  repository: "acme/web",
  webUrl: (number: number) => changeRequestWebUrl("gitlab", "gitlab.com", "acme/web", number),
};

describe("resolveLinkPullRequestInput", () => {
  it.each([["https://git.acme.test/acme/web/-/merge_requests/42", "git.acme.test"]])(
    "links supported host URL %s without a thread project",
    (url, host) => {
      expect(
        resolveLinkPullRequestInput({
          reference: ` ${url} `,
          project: null,
          hasProject: (candidate) => candidate.host === host,
        }),
      ).toEqual({ link: { host, repository: "acme/web", number: 42, url } });
    },
  );

  it.each([
    "https://github.com/acme/web/pull/42",
    "https://bitbucket.org/acme/web/pull-requests/42",
    "https://dev.azure.com/org/project/_git/web/pullrequest/42",
  ])("rejects unsupported provider URL %s", (reference) => {
    expect(
      resolveLinkPullRequestInput({ reference, project: null, hasProject: () => true }),
    ).toBeNull();
  });

  it("resolves a bare number against the thread's own repository", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "#42", project, hasProject: () => true }),
    ).toEqual({
      link: {
        host: "gitlab.com",
        repository: "acme/web",
        number: 42,
        url: "https://gitlab.com/acme/web/-/merge_requests/42",
      },
    });
  });

  it("links a URL from another repository on a host with a project", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "https://gitlab.com/acme/api/-/merge_requests/7",
        project,
        hasProject: (reference) => reference.host === "gitlab.com",
      }),
    ).toEqual({
      link: {
        host: "gitlab.com",
        repository: "acme/api",
        number: 7,
        url: "https://gitlab.com/acme/api/-/merge_requests/7",
      },
    });
  });

  it("refuses a URL on a host nothing is checked out from", () => {
    const result = resolveLinkPullRequestInput({
      reference: "https://gitlab.com/acme/api/-/merge_requests/7",
      project,
      hasProject: () => false,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("gitlab.com") });
  });
});

describe("changeRequestWebUrl", () => {
  it("builds GitLab URLs and rejects unknown providers", () => {
    expect(changeRequestWebUrl("gitlab", "gitlab.com", "g/sub/repo", 5)).toBe(
      "https://gitlab.com/g/sub/repo/-/merge_requests/5",
    );
    expect(changeRequestWebUrl("unknown", "x", "a/b", 1)).toBeNull();
  });
});

describe("parsePullRequestReference", () => {
  it("accepts raw numbers and #number references", () => {
    expect(parsePullRequestReference("42")).toBe("42");
    expect(parsePullRequestReference("#42")).toBe("42");
  });

  it("accepts glab mr checkout commands", () => {
    expect(parsePullRequestReference("glab mr checkout 42")).toBe("42");
    expect(parsePullRequestReference("glab mr checkout #42")).toBe("42");
  });

  it("rejects other providers and non-MR input", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBeNull();
    expect(parsePullRequestReference("https://github.com/acme/project/pull/42")).toBeNull();
    expect(parsePullRequestReference("az repos pr checkout --id 42")).toBeNull();
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });
});
