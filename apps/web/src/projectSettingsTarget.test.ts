import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { projectSettingsTarget } from "./projectSettingsTarget";

it("scopes project settings anchors without delimiter collisions", () => {
  const target = (environment: string, project: string) =>
    projectSettingsTarget({
      environmentId: EnvironmentId.make(environment),
      id: ProjectId.make(project),
    });
  expect(target("a-b", "c").hash).not.toBe(target("a", "b-c").hash);
  expect(target("environment", "project").to).toBe("/settings/source-control");
});
