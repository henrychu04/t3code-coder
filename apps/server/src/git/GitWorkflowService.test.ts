import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

const getChangeRequest = vi.fn(() =>
  Effect.succeed({
    provider: "gitlab" as const,
    number: 42,
    title: "Restore the panel",
    url: "https://gitlab.example.com/group/project/-/merge_requests/42",
    baseRefName: "main",
    headRefName: "feature/panel",
    state: "open" as const,
    updatedAt: Option.none(),
  }),
);
const checkoutChangeRequest = vi.fn(() => Effect.void);
const provider = {
  kind: "gitlab" as const,
  getChangeRequest,
  checkoutChangeRequest,
} as unknown as SourceControlProvider.SourceControlProvider["Service"];

const listRefs = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listRefs"]>();
const createWorktree = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>();
const refStatusLocal = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["refStatusLocal"]>();

const layer = it.layer(
  GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listRefs,
          createWorktree,
          refStatusLocal,
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          get: () => Effect.succeed(provider),
        }),
      ),
    ),
  ),
);

layer("GitWorkflowService.preparePullRequestThread", (it) => {
  it.effect("checks an MR out in the project checkout", () =>
    Effect.gen(function* () {
      refStatusLocal.mockReturnValueOnce(
        Effect.succeed({ isRepo: true, refName: "feature/panel" }),
      );
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "local",
      });

      expect(checkoutChangeRequest).toHaveBeenCalledWith({
        cwd: "/repo",
        reference: "42",
        force: true,
      });
      expect(result).toMatchObject({
        branch: "feature/panel",
        worktreePath: null,
        isOnPullRequestHead: true,
      });
    }),
  );

  it.effect("creates an isolated branch and checks the MR out inside its worktree", () =>
    Effect.gen(function* () {
      listRefs.mockReturnValueOnce(
        Effect.succeed({
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        }),
      );
      createWorktree.mockReturnValueOnce(
        Effect.succeed({
          worktree: {
            path: "/worktrees/project/t3code-mr-42-thread-1",
            refName: "t3code/mr-42-thread-1",
          },
        }),
      );
      refStatusLocal.mockReturnValueOnce(
        Effect.succeed({ isRepo: true, refName: "t3code/mr-42-thread-1" }),
      );
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread-1"),
      });

      expect(createWorktree).toHaveBeenCalledWith({
        cwd: "/repo",
        refName: "HEAD",
        newRefName: "t3code/mr-42-thread-1",
        path: null,
      });
      expect(checkoutChangeRequest).toHaveBeenCalledWith({
        cwd: "/worktrees/project/t3code-mr-42-thread-1",
        reference: "42",
        branch: "t3code/mr-42-thread-1",
        force: true,
      });
      expect(result).toMatchObject({
        branch: "t3code/mr-42-thread-1",
        worktreePath: "/worktrees/project/t3code-mr-42-thread-1",
        isOnPullRequestHead: true,
      });
    }),
  );
});

it.effect("coalesces status reads and invalidates them explicitly", () => {
  let statusReads = 0;
  const testLayer = GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetailsLocal: () =>
            Effect.sync(() => {
              statusReads += 1;
              return {
                isRepo: true,
                isDefaultBranch: false,
                branch: "feature/cache",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              };
            }),
          execute: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "git@gitlab.example.com:group/project.git\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          get: () => Effect.succeed(provider),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    yield* Effect.all(
      Array.from({ length: 8 }, () => workflow.localStatus({ cwd: "/repo" })),
      { concurrency: "unbounded" },
    );
    expect(statusReads).toBe(1);

    yield* workflow.invalidateStatus("/repo");
    yield* workflow.localStatus({ cwd: "/repo" });
    expect(statusReads).toBe(2);
  }).pipe(Effect.provide(testLayer));
});

it.effect("commits, pushes, and creates a GitLab merge request through the workflow", () => {
  let listCalls = 0;
  const createdRequests: unknown[] = [];
  const mergeRequest = {
    provider: "gitlab" as const,
    number: 17,
    title: "Restore Git actions",
    url: "https://gitlab.example.com/group/project/-/merge_requests/17",
    baseRefName: "main",
    headRefName: "feature/panel",
    state: "open" as const,
    updatedAt: Option.none(),
  };
  const workflowProvider = {
    kind: "gitlab" as const,
    listChangeRequests: () => {
      listCalls += 1;
      return Effect.succeed(listCalls === 1 ? [] : [mergeRequest]);
    },
    createChangeRequest: (input: unknown) =>
      Effect.sync(() => {
        createdRequests.push(input);
      }),
  } as unknown as SourceControlProvider.SourceControlProvider["Service"];
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-workflow-actions-",
  });
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(configLayer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const workflowLayer = GitWorkflowService.layer.pipe(
    Layer.provideMerge(gitLayer),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(workflowProvider),
      }),
    ),
  );

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-action-" });
    const repo = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(remote);
    const run = (cwd: string, args: readonly string[]) =>
      git.execute({ operation: "GitWorkflowService.test", cwd, args });
    yield* run(repo, ["init", "--initial-branch=main"]);
    yield* run(repo, ["config", "user.email", "test@test.com"]);
    yield* run(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "initial\n");
    yield* run(repo, ["add", "README.md"]);
    yield* run(repo, ["commit", "-m", "Initial"]);
    yield* run(remote, ["init", "--bare", "--initial-branch=main"]);
    yield* run(repo, ["remote", "add", "origin", remote]);
    yield* run(repo, ["push", "--set-upstream", "origin", "main"]);
    yield* run(repo, ["switch", "-c", "feature/panel"]);
    yield* fileSystem.writeFileString(path.join(repo, "panel.ts"), "export const panel = true;\n");
    yield* fileSystem.writeFileString(
      path.join(repo, "excluded.ts"),
      "export const excluded = true;\n",
    );
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    yield* fileSystem.writeFileString(hookPath, "#!/bin/sh\necho checking-panel >&2\n");
    yield* fileSystem.chmod(hookPath, 0o755);
    const progress: string[] = [];

    const result = yield* workflow.runStackedAction(
      {
        actionId: "action-1",
        cwd: repo,
        action: "commit_push_pr",
        commitMessage: "Restore Git actions",
        filePaths: ["panel.ts"],
      },
      {
        publish: (event) =>
          Effect.sync(() => {
            progress.push(event.kind);
          }),
      },
    );

    expect(result.commit.status).toBe("created");
    expect(result.push).toMatchObject({
      status: "pushed",
      branch: "feature/panel",
      upstreamBranch: "origin/feature/panel",
      setUpstream: true,
    });
    expect(result.pr).toMatchObject({
      status: "created",
      number: 17,
      headBranch: "feature/panel",
      baseBranch: "main",
    });
    expect(createdRequests).toEqual([
      {
        cwd: repo,
        baseRefName: "main",
        headSelector: "feature/panel",
        title: "Restore Git actions",
        bodyFile: "/dev/null",
      },
    ]);
    expect(progress[0]).toBe("action_started");
    expect(progress).toContain("hook_started");
    expect(progress).toContain("hook_output");
    expect(progress).toContain("hook_finished");
    expect(progress.at(-1)).toBe("action_finished");
    const remaining = yield* run(repo, ["status", "--short"]);
    expect(remaining.stdout).toContain("?? excluded.ts");
  }).pipe(Effect.scoped, Effect.provide(workflowLayer), Effect.provide(NodeServices.layer));
});
