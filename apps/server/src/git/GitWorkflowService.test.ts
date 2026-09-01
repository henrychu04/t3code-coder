import { beforeEach, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
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
const listChangeRequests =
  vi.fn<SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"]>();
const checkoutChangeRequest = vi.fn(() => Effect.void);
const getRepositoryCloneUrls = vi.fn(() =>
  Effect.succeed({
    nameWithOwner: "contributor/project",
    url: "https://gitlab.example.com/contributor/project.git",
    sshUrl: "git@gitlab.example.com:contributor/project.git",
  }),
);
const provider = {
  kind: "gitlab" as const,
  getChangeRequest,
  listChangeRequests,
  checkoutChangeRequest,
  getRepositoryCloneUrls,
} as unknown as SourceControlProvider.SourceControlProvider["Service"];

const listRefs = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listRefs"]>();
const createWorktree = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>();
const refStatusLocal = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["refStatusLocal"]>();
const execute = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["execute"]>();
const ensureRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>();
const runSetupScript =
  vi.fn<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]>();

function gitOutput(stdout = "", exitCode = 0): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation((input) => {
    if (input.args[0] === "remote" && input.args.length === 1) {
      return Effect.succeed(gitOutput("origin\n"));
    }
    if (input.args[0] === "config" && input.args[1] === "--get") {
      return Effect.succeed(gitOutput("git@gitlab.example.com:group/project.git\n"));
    }
    return Effect.succeed(gitOutput());
  });
  ensureRemote.mockReset();
  ensureRemote.mockReturnValue(Effect.succeed("fork"));
  runSetupScript.mockReset();
  runSetupScript.mockReturnValue(Effect.succeed({ status: "no-script" }));
  listRefs.mockReset();
  createWorktree.mockReset();
  refStatusLocal.mockReset();
  checkoutChangeRequest.mockClear();
  getRepositoryCloneUrls.mockClear();
  getChangeRequest.mockClear();
  listChangeRequests.mockReset();
  listChangeRequests.mockReturnValue(
    Effect.succeed([
      {
        provider: "gitlab" as const,
        number: 42,
        title: "Restore the panel",
        url: "https://gitlab.example.com/group/project/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/panel",
        state: "open" as const,
        updatedAt: Option.none(),
      },
    ]),
  );
});

const layer = it.layer(
  GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute,
          ensureRemote,
          listRefs,
          createWorktree,
          refStatusLocal,
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: runSetupScript,
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
      listRefs.mockReturnValueOnce(
        Effect.succeed({
          refs: [
            {
              name: "feature/panel",
              isRemote: false,
              worktreePath: null,
              current: false,
              isDefault: false,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      );
      createWorktree.mockReturnValueOnce(
        Effect.succeed({
          worktree: {
            path: "/worktrees/project/feature-panel",
            refName: "feature/panel",
          },
        }),
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
        refName: "feature/panel",
        path: null,
      });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo",
          args: ["fetch", "origin", "+refs/merge-requests/42/head:refs/heads/feature/panel"],
        }),
      );
      expect(runSetupScript).toHaveBeenCalledWith({
        threadId: "thread-1",
        projectCwd: "/repo",
        worktreePath: "/worktrees/project/feature-panel",
      });
      expect(result).toMatchObject({
        branch: "feature/panel",
        worktreePath: "/worktrees/project/feature-panel",
        isOnPullRequestHead: true,
      });
    }),
  );

  it.effect("refreshes a clean reused worktree after the MR head is force-pushed", () =>
    Effect.gen(function* () {
      listRefs.mockReturnValue(
        Effect.succeed({
          refs: [
            {
              name: "feature/panel",
              isRemote: false,
              worktreePath: "/worktrees/project/feature-panel",
              current: false,
              isDefault: false,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "rev-parse") {
          const revision = input.args[1];
          return Effect.succeed(
            gitOutput(revision === "refs/t3code/merge-requests/42/head" ? "new\n" : "old\n"),
          );
        }
        if (input.args[0] === "status") return Effect.succeed(gitOutput());
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread-1"),
      });

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/worktrees/project/feature-panel",
          args: ["reset", "--hard", "new"],
        }),
      );
      expect(runSetupScript).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        worktreePath: "/worktrees/project/feature-panel",
        isOnPullRequestHead: true,
      });
    }),
  );

  it.effect("preserves dirty work in a reused worktree and reports that it is stale", () =>
    Effect.gen(function* () {
      listRefs.mockReturnValue(
        Effect.succeed({
          refs: [
            {
              name: "feature/panel",
              isRemote: false,
              worktreePath: "/worktrees/project/feature-panel",
              current: false,
              isDefault: false,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "rev-parse") {
          const revision = input.args[1];
          return Effect.succeed(
            gitOutput(revision === "refs/t3code/merge-requests/42/head" ? "new\n" : "old\n"),
          );
        }
        if (input.args[0] === "status") return Effect.succeed(gitOutput(" M src/panel.ts\n"));
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread-1"),
      });

      expect(execute.mock.calls.some((call) => call[0].args[0] === "reset")).toBe(false);
      expect(runSetupScript).not.toHaveBeenCalled();
      expect(result.isOnPullRequestHead).toBe(false);
    }),
  );

  it.effect("preserves local commits in a reused worktree", () =>
    Effect.gen(function* () {
      listRefs.mockReturnValue(
        Effect.succeed({
          refs: [
            {
              name: "feature/panel",
              isRemote: false,
              worktreePath: "/worktrees/project/feature-panel",
              current: false,
              isDefault: false,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "rev-parse") {
          const revision = input.args[1];
          return Effect.succeed(
            gitOutput(
              revision === "@{upstream}"
                ? "base\n"
                : revision === "refs/t3code/merge-requests/42/head"
                  ? "new\n"
                  : "local\n",
            ),
          );
        }
        if (input.args[0] === "merge-base") return Effect.succeed(gitOutput("", 1));
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
      });

      expect(
        execute.mock.calls.some(
          (call) => call[0].args[0] === "reset" || call[0].args[0] === "merge",
        ),
      ).toBe(false);
      expect(result.isOnPullRequestHead).toBe(false);
    }),
  );

  it.effect("preserves local commits on a branch that is not attached to a worktree", () =>
    Effect.gen(function* () {
      listRefs.mockReturnValue(
        Effect.succeed({
          refs: [
            {
              name: "feature/panel",
              isRemote: false,
              worktreePath: null,
              current: false,
              isDefault: false,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      );
      createWorktree.mockReturnValueOnce(
        Effect.succeed({
          worktree: {
            path: "/worktrees/project/feature-panel",
            refName: "feature/panel",
          },
        }),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "rev-parse") {
          const revision = input.args[1];
          return Effect.succeed(
            gitOutput(
              revision === "@{upstream}"
                ? "base\n"
                : revision === "refs/t3code/merge-requests/42/head"
                  ? "new\n"
                  : "local\n",
            ),
          );
        }
        if (input.args[0] === "merge-base") return Effect.succeed(gitOutput("", 1));
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread-1"),
      });

      expect(createWorktree).toHaveBeenCalledWith({
        cwd: "/repo",
        refName: "feature/panel",
        path: null,
      });
      expect(
        execute.mock.calls.some(
          (call) =>
            call[0].args[0] === "fetch" &&
            call[0].args.some((arg) => arg.endsWith(":refs/heads/feature/panel")),
        ),
      ).toBe(false);
      expect(
        execute.mock.calls.some(
          (call) => call[0].args[0] === "reset" || call[0].args[0] === "merge",
        ),
      ).toBe(false);
      expect(runSetupScript).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        worktreePath: "/worktrees/project/feature-panel",
        isOnPullRequestHead: false,
      });
    }),
  );

  it.effect("uses a namespaced local branch and fork remote for cross-project MRs", () =>
    Effect.gen(function* () {
      getChangeRequest.mockReturnValueOnce(
        Effect.succeed({
          provider: "gitlab" as const,
          number: 42,
          title: "Restore the panel",
          url: "https://gitlab.example.com/group/project/-/merge_requests/42",
          baseRefName: "main",
          headRefName: "Feature/Panel",
          state: "open" as const,
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "contributor/project",
          headRepositoryOwnerLogin: "contributor",
        }),
      );
      listRefs
        .mockReturnValueOnce(
          Effect.succeed({
            refs: [],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 0,
          }),
        )
        .mockReturnValueOnce(
          Effect.succeed({
            refs: [
              {
                name: "t3code/pr-42/feature/panel",
                isRemote: false,
                worktreePath: null,
                current: false,
                isDefault: false,
              },
            ],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
          }),
        );
      createWorktree.mockReturnValueOnce(
        Effect.succeed({
          worktree: {
            path: "/worktrees/project/fork-panel",
            refName: "t3code/pr-42/feature/panel",
          },
        }),
      );
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.preparePullRequestThread({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
      });

      expect(ensureRemote).toHaveBeenCalledWith({
        cwd: expect.any(String),
        preferredName: "contributor",
        url: expect.any(String),
      });
      expect(createWorktree).toHaveBeenCalledWith({
        cwd: "/repo",
        refName: "t3code/pr-42/feature/panel",
        path: null,
      });
      expect(result.branch).toBe("t3code/pr-42/feature/panel");
    }),
  );
});

layer("GitWorkflowService.branchPullRequest", (it) => {
  it.effect("resolves a saved branch merge request without changing the checkout", () =>
    Effect.gen(function* () {
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/feature/panel") {
          return Effect.succeed(
            gitOutput(
              "refs/heads/feature/panel\0origin/feature/panel\0origin\0refs/heads/feature/panel\n",
            ),
          );
        }
        if (input.args[0] === "symbolic-ref") {
          return Effect.succeed(gitOutput("origin/main\n"));
        }
        if (input.args[0] === "config" && input.args[1] === "--get") {
          return Effect.succeed(gitOutput("git@gitlab.example.com:group/project.git\n"));
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({
        cwd: "/repo",
        branch: "feature/panel",
      });

      expect(result).toEqual({ state: "open", updatedAt: null });
      expect(listChangeRequests).toHaveBeenCalledWith({
        cwd: "/repo",
        headSelector: "feature/panel",
        state: "all",
        limit: 20,
      });
      expect(
        execute.mock.calls.some(([input]) =>
          ["checkout", "switch", "fetch", "pull", "push"].includes(input.args[0] ?? ""),
        ),
      ).toBe(false);
    }),
  );

  it.effect("rejects an unqualified branch tracked by multiple remotes", () =>
    Effect.gen(function* () {
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\nfork\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/feature/panel") {
          return Effect.succeed(gitOutput());
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/remotes") {
          return Effect.succeed(
            gitOutput("refs/remotes/origin/feature/panel\nrefs/remotes/fork/feature/panel\n"),
          );
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const error = yield* service
        .branchPullRequest({ cwd: "/repo", branch: "feature/panel" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        detail: "Multiple remotes track feature/panel. Its merge request is ambiguous.",
      });
      expect(listChangeRequests).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not query GitLab for a known unpublished local branch", () =>
    Effect.gen(function* () {
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/feature/panel") {
          return Effect.succeed(gitOutput("refs/heads/feature/panel\0\0\0\n"));
        }
        if (input.args[0] === "symbolic-ref") {
          return Effect.succeed(gitOutput("origin/main\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/remotes") {
          return Effect.succeed(gitOutput("refs/remotes/origin/main\n"));
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({
        cwd: "/repo",
        branch: "feature/panel",
      });

      expect(result).toBeNull();
      expect(listChangeRequests).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses the default branch of a non-origin remote", () =>
    Effect.gen(function* () {
      listChangeRequests.mockReturnValueOnce(
        Effect.succeed([
          {
            provider: "gitlab" as const,
            number: 43,
            title: "Merged main branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/43",
            baseRefName: "develop",
            headRefName: "main",
            state: "merged" as const,
            updatedAt: Option.none(),
          },
        ]),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("upstream\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/main") {
          return Effect.succeed(
            gitOutput("refs/heads/main\0upstream/main\0upstream\0refs/heads/main\n"),
          );
        }
        if (input.args[0] === "symbolic-ref") {
          return Effect.succeed(gitOutput("upstream/develop\n"));
        }
        if (input.args[0] === "config" && input.args[1] === "--get") {
          return Effect.succeed(gitOutput("git@gitlab.example.com:group/project.git\n"));
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({ cwd: "/repo", branch: "main" });

      expect(result).toEqual({ state: "merged", updatedAt: null });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/upstream/HEAD"],
        }),
      );
    }),
  );

  it.effect("suppresses terminal master MRs when the remote default cannot be resolved", () =>
    Effect.gen(function* () {
      listChangeRequests.mockReturnValueOnce(
        Effect.succeed([
          {
            provider: "gitlab" as const,
            number: 48,
            title: "Merged master branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/48",
            baseRefName: "master",
            headRefName: "master",
            state: "merged" as const,
            updatedAt: Option.none(),
          },
        ]),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/master") {
          return Effect.succeed(
            gitOutput("refs/heads/master\0origin/master\0origin\0refs/heads/master\n"),
          );
        }
        if (input.args[0] === "show-ref") {
          return Effect.succeed(gitOutput("", 1));
        }
        if (input.args[0] === "config" && input.args[1] === "--get") {
          return Effect.succeed(gitOutput("git@gitlab.example.com:group/project.git\n"));
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({ cwd: "/repo", branch: "master" });

      expect(result).toBeNull();
    }),
  );

  it.effect("disambiguates fork merge requests by remote repository identity", () =>
    Effect.gen(function* () {
      listChangeRequests.mockReturnValueOnce(
        Effect.succeed([
          {
            provider: "gitlab" as const,
            number: 44,
            title: "Unrelated branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/44",
            baseRefName: "main",
            headRefName: "feature/panel",
            headRepositoryNameWithOwner: "group/project",
            state: "closed" as const,
            updatedAt: Option.none(),
          },
          {
            provider: "gitlab" as const,
            number: 45,
            title: "Fork branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/45",
            baseRefName: "main",
            headRefName: "feature/panel",
            headRepositoryNameWithOwner: "contributor/project",
            state: "merged" as const,
            updatedAt: Option.none(),
          },
        ]),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\nfork\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/feature/panel") {
          return Effect.succeed(
            gitOutput(
              "refs/heads/feature/panel\0fork/feature/panel\0fork\0refs/heads/feature/panel\n",
            ),
          );
        }
        if (input.args[0] === "symbolic-ref") {
          return Effect.succeed(gitOutput("origin/main\n"));
        }
        if (input.args[0] === "config" && input.args[1] === "--get") {
          const key = input.args[2];
          return Effect.succeed(
            gitOutput(
              key === "remote.fork.url"
                ? "git@gitlab.example.com:contributor/project.git\n"
                : "git@gitlab.example.com:group/project.git\n",
            ),
          );
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({
        cwd: "/repo",
        branch: "feature/panel",
      });

      expect(result).toEqual({ state: "merged", updatedAt: null });
    }),
  );

  it.effect("does not attach a fork MR to a same-named target-repository branch", () =>
    Effect.gen(function* () {
      listChangeRequests.mockReturnValueOnce(
        Effect.succeed([
          {
            provider: "gitlab" as const,
            number: 46,
            title: "Fork branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/46",
            baseRefName: "main",
            headRefName: "feature/panel",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "contributor/project",
            headRepositoryOwnerLogin: "contributor",
            state: "closed" as const,
            updatedAt: Option.none(),
          },
          {
            provider: "gitlab" as const,
            number: 47,
            title: "Target branch",
            url: "https://gitlab.example.com/group/project/-/merge_requests/47",
            baseRefName: "main",
            headRefName: "feature/panel",
            isCrossRepository: false,
            headRepositoryNameWithOwner: "group/project",
            headRepositoryOwnerLogin: "group",
            state: "merged" as const,
            updatedAt: Option.none(),
          },
        ]),
      );
      execute.mockImplementation((input) => {
        if (input.args[0] === "remote" && input.args.length === 1) {
          return Effect.succeed(gitOutput("origin\n"));
        }
        if (input.args[0] === "for-each-ref" && input.args.at(-1) === "refs/heads/feature/panel") {
          return Effect.succeed(
            gitOutput(
              "refs/heads/feature/panel\0origin/feature/panel\0origin\0refs/heads/feature/panel\n",
            ),
          );
        }
        if (input.args[0] === "symbolic-ref") {
          return Effect.succeed(gitOutput("origin/main\n"));
        }
        if (input.args[0] === "config" && input.args[1] === "--get") {
          return Effect.succeed(gitOutput("git@gitlab.example.com:group/project.git\n"));
        }
        return Effect.succeed(gitOutput());
      });
      const service = yield* GitWorkflowService.GitWorkflowService;

      const result = yield* service.branchPullRequest({
        cwd: "/repo/same-target",
        branch: "feature/panel",
      });

      expect(result).toEqual({ state: "merged", updatedAt: null });
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
