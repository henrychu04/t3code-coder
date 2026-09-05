import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { projectSettingsTarget, parseProjectSettingsKey } from "./projectSettingsTarget";

it("scopes project settings routes without delimiter collisions or hash anchors", () => {
  const target = (environment: string, project: string) =>
    projectSettingsTarget({
      environmentId: EnvironmentId.make(environment),
      id: ProjectId.make(project),
    });
  expect(target("a-b", "c").params.projectKey).not.toBe(target("a", "b-c").params.projectKey);
  expect(target("environment", "project").to).toBe("/projects/$projectKey");
  expect(target("environment", "project")).not.toHaveProperty("hash");
  const key = target("environment:one", "project/with % spaces").params.projectKey;
  expect(parseProjectSettingsKey(decodeURIComponent(encodeURIComponent(key)))).toEqual({
    environmentId: "environment:one",
    projectId: "project/with % spaces",
  });
});

it("rejects malformed project settings routes", () => {
  for (const key of [
    "broken",
    "null",
    "{}",
    "[]",
    '["env"]',
    '["env",""]',
    '[1,"project"]',
    '["env","project","extra"]',
  ])
    expect(parseProjectSettingsKey(key)).toBeNull();
});
