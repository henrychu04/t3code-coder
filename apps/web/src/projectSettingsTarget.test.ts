import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { isRedirect } from "@tanstack/react-router";
import { Route } from "./routes/projects.$projectKey";
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

it("redirects existing project links into the settings layout with an explicit target", () => {
  const target = projectSettingsTarget({
    environmentId: EnvironmentId.make("workspace"),
    id: ProjectId.make("project"),
  });
  try {
    Route.options.beforeLoad!({ params: target.params } as never);
    expect.fail("Expected the project route to redirect");
  } catch (error) {
    expect(isRedirect(error)).toBe(true);
    if (!isRedirect(error)) throw error;
    expect(error.options).toMatchObject({
      to: "/settings/projects",
      replace: true,
      search: { project: target.params.projectKey, machine: undefined, checkout: undefined },
    });
  }
});
