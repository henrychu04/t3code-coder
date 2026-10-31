import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
    }),
  );

  for (const repository of [
    "https://gitlab.com/group/project",
    "https://code.example.com:8443/group/subgroup/project",
    "http://code.example.com/group/project",
  ]) {
    it.effect(`uses an explicit MR number and repository for URLs on ${repository}`, () =>
      Effect.gen(function* () {
        const reference = `${repository}/-/merge_requests/42/diffs?view=parallel#note_123`;
        mockedRun.mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                iid: 42,
                title: "Checkout by URL",
                web_url: `${repository}/-/merge_requests/42`,
                target_branch: "main",
                source_branch: "feature/checkout",
              }),
            ),
          ),
        );
        mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.getMergeRequest({ cwd: "/repo", reference });
        yield* glab.checkoutMergeRequest({ cwd: "/repo", reference });

        expect(result.number).toBe(42);
        expect(mockedRun).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            args: ["mr", "view", "--repo", repository, "--output", "json", "--", "42"],
          }),
        );
        expect(mockedRun).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            args: ["mr", "checkout", "--repo", repository, "--", "42"],
          }),
        );
      }),
    );
  }

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("creates a fork merge request from the source project into the current target", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                id: 100,
                path: "project",
                path_with_namespace: "group/project",
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "contributor:feature/provider",
        source: {
          owner: "contributor",
          repository: "contributor/project",
          refName: "feature/provider",
        },
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ args: ["api", "projects/:fullpath"] }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          args: expect.arrayContaining([
            "projects/contributor%2Fproject/merge_requests",
            "target_project_id=100",
          ]),
        }),
      );
      expect(mockedRun.mock.calls[1]?.[0].args).not.toContain(
        "source_project_id=contributor/project",
      );
    }),
  );

  it.effect("resolves an explicit target project for a fork merge request", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                id: 200,
                path: "project",
                path_with_namespace: "contributor/project",
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                id: 100,
                path: "project",
                path_with_namespace: "group/project",
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        target: {
          repository: "group/project",
          refName: "main",
        },
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ args: ["api", "projects/group%2Fproject"] }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          args: expect.arrayContaining([
            "projects/:fullpath/merge_requests",
            "target_project_id=100",
          ]),
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("keeps non-merge-request not-found failures generic", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
