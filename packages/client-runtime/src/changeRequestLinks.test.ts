import {
  EnvironmentId,
  ProjectId,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForChangeRequest,
  projectChangeRequestUrl,
  resolvePullRequestPreviewTarget,
} from "./changeRequestLinks.ts";

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: SourceControlProviderKind.make("gitlab"),
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

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: SourceControlProviderKind.make("github"),
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

describe("resolvePullRequestPreviewTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = {
    id: ProjectId.make("project-1"),
    environmentId,
    // Coder: GitLab fixtures; GitLab is the only host.
    repositoryIdentity: {
      canonicalKey: "gitlab.com/acme/web",
      provider: SourceControlProviderKind.make("gitlab"),
      displayName: "acme/web",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@gitlab.com:acme/web" },
    } satisfies RepositoryIdentity,
  };

  it("previews a pull request only under the project that holds its repository", () => {
    const target = (url: string) =>
      resolvePullRequestPreviewTarget({
        environmentId,
        projects: [project],
        pullRequestsEnabled: true,
        url,
      });
    expect(target("https://gitlab.com/acme/web/-/merge_requests/7")).toEqual({
      environmentId,
      input: { projectId: project.id, host: "gitlab.com", repository: "acme/web", number: 7 },
    });
    expect(target("https://gitlab.com/acme/other/-/merge_requests/7")).toBeNull();
  });
});

describe("projectChangeRequestUrl", () => {
  // Coder: GitLab fixtures; upstream's Azure short-selector case has no GitLab counterpart.
  const identity = (provider: string): RepositoryIdentity => ({
    canonicalKey: "gitlab.com/acme/default",
    provider: SourceControlProviderKind.make(provider),
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@gitlab.com:acme/default",
    },
  });

  it("builds the requested repository's URL on the project's host", () => {
    expect(projectChangeRequestUrl(identity("gitlab"), "acme/other", 42)).toBe(
      "https://gitlab.com/acme/other/-/merge_requests/42",
    );
  });

  it("builds nothing without a project host that knows its URL shape", () => {
    expect(projectChangeRequestUrl(null, "acme/repository", 1)).toBeNull();
    expect(projectChangeRequestUrl(identity("unknown"), "acme/repository", 1)).toBeNull();
    const { provider: _provider, ...withoutProvider } = identity("gitlab");
    expect(projectChangeRequestUrl(withoutProvider, "acme/repository", 1)).toBeNull();
  });
});
