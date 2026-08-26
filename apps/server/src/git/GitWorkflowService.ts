import type {
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRemoveWorktreeInput,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
    readonly moveWorktree: (input: {
      readonly cwd: string;
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/git/GitWorkflowService") {}

export const layer = Layer.effect(
  GitWorkflowService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return GitWorkflowService.of({
      localStatus: ({ cwd }) =>
        git.statusDetailsLocal(cwd).pipe(
          Effect.map((details) => ({
            isRepo: details.isRepo,
            isDefaultRef: details.isDefaultBranch,
            refName: details.branch,
            hasWorkingTreeChanges: details.hasWorkingTreeChanges,
            workingTree: details.workingTree,
          })),
        ),
      listRefs: git.listRefs,
      createWorktree: git.createWorktree,
      removeWorktree: git.removeWorktree,
      pruneWorktrees: git.pruneWorktrees,
      createRef: git.createRef,
      switchRef: (input) => Effect.scoped(git.switchRef(input)),
      renameBranch: git.renameBranch,
      moveWorktree: git.moveWorktree,
    });
  }),
);
