import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitLabMergeRequestView,
  GitLabMergeRequestService,
  layer,
} from "./GitLabMergeRequestService.ts";

const rawMergeRequest = JSON.stringify({
  iid: 42,
  title: "Restore the review panel",
  web_url: "https://gitlab.example/group/project/-/merge_requests/42",
  description: "A merge request.",
  author: { username: "alice", name: "Alice", avatar_url: null },
  source_branch: "feature/review-panel",
  target_branch: "main",
  state: "opened",
  draft: false,
  merge_status: "can_be_merged",
  created_at: "2026-08-27T12:00:00Z",
  updated_at: "2026-08-28T12:00:00Z",
  merged_at: null,
  closed_at: null,
  reviewers: [{ username: "bob", name: "Bob", avatar_url: null }],
  assignees: [],
  labels: ["frontend"],
  changes_count: "7",
  head_pipeline: { status: "success", web_url: "https://gitlab.example/pipeline/1" },
});

describe("GitLabMergeRequestService", () => {
  it("normalizes the GitLab merge request response", () => {
    const result = decodeGitLabMergeRequestView(rawMergeRequest);
    assert.strictEqual(result.number, 42);
    assert.strictEqual(result.state, "open");
    assert.strictEqual(result.mergeability, "mergeable");
    assert.strictEqual(result.changedFiles, 7);
    assert.deepStrictEqual(
      result.reviewers.map((reviewer) => reviewer.login),
      ["bob"],
    );
    assert.strictEqual(result.pipeline?.status, "success");
  });

  it.effect("resolves the current merge request with glab in the requested workspace", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const testLayer = layer.pipe(
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: rawMergeRequest,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const service = yield* GitLabMergeRequestService;
        return yield* service.viewCurrent({ cwd: "/workspace/project" });
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(result.mergeRequest?.number, 42);
      assert.deepStrictEqual(calls, [
        {
          operation: "GitLabMergeRequestService.viewCurrent",
          command: "glab",
          args: ["mr", "view", "--output", "json"],
          cwd: "/workspace/project",
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxOutputBytes: 1024 * 1024,
        },
      ]);
    }),
  );

  it.effect("treats a branch without a merge request as an empty view", () =>
    Effect.gen(function* () {
      const testLayer = layer.pipe(
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(1),
                stdout: "",
                stderr: "No merge request found for source branch",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          }),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* GitLabMergeRequestService;
        return yield* service.viewCurrent({ cwd: "/workspace/project" });
      }).pipe(Effect.provide(testLayer));
      assert.isNull(result.mergeRequest);
    }),
  );
});
