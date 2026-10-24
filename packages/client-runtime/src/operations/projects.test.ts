import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  normalizePastedCloneUrl,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  // Coder: shorthand goes to the first host, GitLab, over its default SSH transport.
  it("routes owner/repository shorthand to the default host", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe("git@gitlab.com:imputnet/helium.git");
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "git@gitlab.com:pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  // Coder: GitLab, the only shipped host, clones over SSH; an unshipped host reads as generic.
  it("uses each host's default clone transport", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("gitlab"),
        url: "https://gitlab.com/group/project",
        sshUrl: "git@gitlab.com:group/project.git",
      }),
    ).toBe("git@gitlab.com:group/project.git");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("git@github.com:imputnet/helium.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});

describe("new project publish targets", () => {
  const readyHost = (kind: string, account: string | null) => ({
    kind: SourceControlProviderKind.make(kind),
    label: kind,
    status: "available" as const,
    installHint: "",
    version: Option.none(),
    detail: Option.none(),
    auth: {
      status: "authenticated" as const,
      account: Option.fromNullOr(account),
      host: Option.none(),
      detail: Option.none(),
    },
  });

  // Coder: GitLab is the only shipped host.
  it("offers GitLab when it is ready, and keeps the pick", () => {
    const targets = getNewProjectPublishTargets({
      versionControlSystems: [],
      sourceControlProviders: [
        readyHost("gitlab", "group"),
        readyHost("github", null),
        readyHost("azure-devops", "me"),
      ],
    });
    expect(targets.map((target) => target.definition.kind)).toEqual(["gitlab"]);
    expect(getNewProjectPublishTarget(targets, null)?.definition.kind).toBe("gitlab");
    expect(
      getNewProjectPublishTarget(targets, SourceControlProviderKind.make("gitlab"))?.owner,
    ).toBe("group");
  });
});
