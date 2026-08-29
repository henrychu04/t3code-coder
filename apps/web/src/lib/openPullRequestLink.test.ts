import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForGitLabMergeRequest,
  parseGitLabMergeRequestUrl,
} from "./openPullRequestLink";

describe("GitLab merge request links", () => {
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
});
