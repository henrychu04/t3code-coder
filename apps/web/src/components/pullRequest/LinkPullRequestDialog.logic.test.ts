import { describe, expect, it } from "vite-plus/test";

import { changeRequestWebUrl, resolveLinkPullRequestInput } from "./LinkPullRequestDialog";

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

  it("returns null for input that is not a reference", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "hello", project, hasProject: () => true }),
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

  it("asks for a URL when a bare number has no project to resolve against", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "12", project: null, hasProject: () => true }),
    ).toMatchObject({ error: expect.stringContaining("full URL") });
  });

  it("accepts a checkout command as a reference", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "glab mr checkout https://gitlab.com/acme/web/-/merge_requests/3",
        project,
        hasProject: () => true,
      }),
    ).toMatchObject({ link: { number: 3, repository: "acme/web" } });
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
