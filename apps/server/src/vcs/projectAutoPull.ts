import type {
  OrchestrationProjectShell,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

export type AutomaticPullSkipReason =
  | "not-a-repository"
  | "not-on-default-branch"
  | "no-upstream"
  | "working-tree-changes"
  | "local-commits"
  | "already-current";

export function automaticPullSkipReason(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): AutomaticPullSkipReason | null {
  if (!local.isRepo) return "not-a-repository";
  if (!local.isDefaultRef) return "not-on-default-branch";
  if (remote === null || !remote.hasUpstream) return "no-upstream";
  if (local.hasWorkingTreeChanges) return "working-tree-changes";
  if (remote.aheadCount > 0) return "local-commits";
  if (remote.behindCount <= 0) return "already-current";
  return null;
}

export const pullProjectIfEligible = Effect.fn("pullProjectIfEligible")(function* (cwd: string) {
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  yield* workflow.invalidateStatus(cwd);
  const remote = yield* workflow.remoteStatus({ cwd }, { fetch: true });
  // Re-read local state after fetching so the final safety check is as fresh
  // as possible immediately before the checkout can move.
  const local = yield* workflow.localStatus({ cwd });
  const skipReason = automaticPullSkipReason(local, remote);
  if (skipReason !== null) {
    yield* Effect.logDebug("Skipped automatic project pull", { cwd, reason: skipReason });
    return false;
  }

  const result = yield* workflow.pull({ cwd });
  yield* workflow.invalidateStatus(cwd);
  yield* Effect.logDebug("Automatic project pull completed", {
    cwd,
    status: result.status,
    refName: result.refName,
  });
  return true;
});

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
) {
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => project.autoPull === true)
        .map((project) => project.workspaceRoot),
    ),
  ];

  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      pullProjectIfEligible(cwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", { cwd, cause }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});
