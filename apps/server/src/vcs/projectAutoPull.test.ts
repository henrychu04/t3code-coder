import { it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { autoPullProjects } from "./projectAutoPull.ts";

const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo",
  autoPull: true,
} as OrchestrationProjectShell;
const eligible = {
  isRepo: true,
  isDefaultBranch: true,
  hasUpstream: true,
  hasWorkingTreeChanges: false,
  aheadCount: 0,
  behindCount: 1,
} as GitVcsDriver.GitStatusDetails;

it.effect.each([
  ["eligible", {}, true],
  ["not a repository", { isRepo: false }, false],
  ["feature branch", { isDefaultBranch: false }, false],
  ["no upstream", { hasUpstream: false }, false],
  ["dirty", { hasWorkingTreeChanges: true }, false],
  ["local commits", { aheadCount: 1 }, false],
  ["already current", { behindCount: 0 }, false],
] as const)("startup auto-pull: %s", ([_name, changes, expected]) => {
  const pulls: string[] = [];
  return autoPullProjects([project]).pipe(
    Effect.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetails: () => Effect.succeed({ ...eligible, ...changes }),
        pullCurrentBranch: (cwd) =>
          Effect.sync(() => {
            pulls.push(cwd);
            return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
          }),
      }),
    ),
    Effect.tap(() => Effect.sync(() => expect(pulls).toEqual(expected ? ["/repo"] : []))),
  );
});

it.effect("startup auto-pull respects per-project enablement and deduplicates roots", () => {
  const reads: string[] = [];
  return autoPullProjects(
    [
      { ...project, autoPull: false, workspaceRoot: "/disabled" },
      project,
      { ...project, id: ProjectId.make("duplicate") },
    ],
    DEFAULT_SERVER_SETTINGS,
  ).pipe(
    Effect.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetails: (cwd) =>
          Effect.sync(() => {
            reads.push(cwd);
            return { ...eligible, behindCount: 0 };
          }),
      }),
    ),
    Effect.tap(() => Effect.sync(() => expect(reads).toEqual(["/repo"]))),
  );
});
