import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestReference } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitLab merge request URLs", () => {
    const reference = "https://gitlab.example.com/group/project/-/merge_requests/42";
    expect(parsePullRequestReference(reference)).toBe(reference);
  });

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
