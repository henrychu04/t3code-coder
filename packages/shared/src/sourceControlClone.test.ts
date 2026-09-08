import { describe, expect, it } from "@effect/vitest";
import { parseGitLabCloneSource } from "./sourceControl.ts";

describe("parseGitLabCloneSource", () => {
  it("routes nested project paths to provider lookup", () => {
    expect(parseGitLabCloneSource(" group/subgroup/project ")).toEqual({
      repository: "group/subgroup/project",
    });
  });

  it.each([
    "https://gitlab.example/group/subgroup/project",
    "https://gitlab.example:8443/group/project.git",
    "http://gitlab.example/group/project.git",
    "https://code.example/group/project.git",
    "git@gitlab.example:group/subgroup/project.git",
    "ssh://git@gitlab.example:2222/group/project.git",
  ])("preserves the direct clone URL %s", (remoteUrl) => {
    expect(parseGitLabCloneSource(` ${remoteUrl} `)).toEqual({ remoteUrl });
  });

  it.each([
    "project",
    "group//project",
    "../project",
    "group/../project",
    "https://gitlab.example/group/project/-/tree/main",
    "https://user:secret@gitlab.example/group/project",
    "https://gitlab.example/group/project?token=secret",
    "https://gitlab.example/group/project#fragment",
    "https://gitlab.example/group/%00project",
    "https://gitlab.example/group/%ZZproject",
    "file:///group/project",
    "ext::command",
    "--hostname evil/project",
    "group/project\\path",
    "https://github.com/group/project",
    "git@bitbucket.org:group/project.git",
    "https://dev.azure.com/org/project/repo",
  ])("rejects unsupported input %s", (input) => {
    expect(parseGitLabCloneSource(input)).toBeNull();
  });
});
