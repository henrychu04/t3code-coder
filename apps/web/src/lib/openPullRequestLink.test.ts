import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
} from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { RepositoryIdentity } from "@t3tools/contracts";

import { gitLabMergeRequestBrowserUrl } from "./openPullRequestLink";

function repositoryIdentity(
  provider: string,
  canonicalKey: string,
  remoteUrl: string,
): RepositoryIdentity {
  return {
    canonicalKey,
    provider: provider as RepositoryIdentity["provider"] & string,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  };
}

const parseChangeRequestUrl = (url: string) =>
  sourceControlClients.parseChangeRequestUrl(url)?.link ?? null;

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
    } as unknown as RepositoryIdentity;
    expect(gitLabMergeRequestBrowserUrl(identity, "group/nested/project", 42)).toBe(url);
    expect(
      gitLabMergeRequestBrowserUrl(
        { ...identity, provider: "unknown" } as RepositoryIdentity,
        "group/nested/project",
        42,
      ),
    ).toBe(url);
    expect(gitLabMergeRequestBrowserUrl(identity, "GROUP/nested/Project", 42)).toBe(
      "https://code.example:8443/gitlab/GROUP/nested/Project/-/merge_requests/42",
    );
    expect(gitLabMergeRequestBrowserUrl(identity, "wrong/project", 42)).toBeNull();
    expect(
      gitLabMergeRequestBrowserUrl(
        { ...identity, provider: "github" } as RepositoryIdentity,
        "group/nested/project",
        42,
      ),
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
    ).toMatchObject({ host: "code.example", repository: "group/project", number: 42 });
    for (const url of [
      "https://github.com/acme/web/pull/42",
      "https://bitbucket.org/acme/web/pull-requests/42",
      "https://forge.example/acme/web/pulls/42",
    ]) {
      expect(parseChangeRequestUrl(url)).toBeNull();
    }
  });
});
