import { ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

// Coder: GitLab is the only host definition, so the cases use a GitLab project in place of
// upstream's Azure DevOps aliases, whose canonical keys live in the uncarried Azure definition.
describe("pullRequestSyncKey", () => {
  const reference = { projectId: ProjectId.make("project"), repository: "group/web", number: 7 };
  const identity = {
    canonicalKey: "gitlab.example/group/web",
    provider: SourceControlProviderKind.make("gitlab"),
    name: "web",
    displayName: "group/web",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "git@gitlab.example:group/web.git",
    },
  };
  it("resolves a hostless reference through the project's host", () => {
    const expected = { host: "gitlab.example", repository: "group/web", number: 7 };
    expect(pullRequestSyncKey(reference, identity)).toEqual(expected);
    expect(pullRequestSyncKey({ ...reference, host: "gitlab.example" }, identity)).toEqual(
      expected,
    );
  });
  it("keys a complete reference without requiring a checkout", () => {
    expect(
      pullRequestSyncKey({ ...reference, host: "GitLab.com", repository: "Group/Web" }),
    ).toEqual({ host: "gitlab.com", repository: "group/web", number: 7 });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});
