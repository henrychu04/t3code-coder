import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestCapabilities,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

const HOST_CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve"] },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const READ_ONLY_CAPABILITIES: PullRequestCapabilities = {
  ...HOST_CAPABILITIES,
  comment: false,
  actions: [],
  mergeMethods: [],
  updateMethods: [],
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};

const project: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "GitLab project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: {
    canonicalKey: "gitlab.example.gs.com/goldman/project",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://gitlab.example.gs.com/goldman/project.git",
    },
    provider: "gitlab",
    displayName: "goldman/project",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const runAction = vi.fn(() => Effect.void);

const provider: PullRequestProviderApi = {
  kind: "gitlab",
  capabilities: HOST_CAPABILITIES,
  getViewer: () => Effect.succeed("coder-user"),
  getViewerPermissions: () =>
    Effect.succeed({
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    }),
  listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: true }),
  getChangeRequest: () =>
    Effect.succeed({
      number: 42,
      title: "Restore GitLab parity",
      url: "https://gitlab.example.gs.com/goldman/project/-/merge_requests/42",
      author: { login: "author", name: null, avatarUrl: null },
      headBranch: "feature/parity",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 4,
      deletions: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      reviewRequestLogins: [],
      labels: [],
      body: "Full feature set through Coder RPC.",
      changedFiles: 1,
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      viewerPermissions: {
        actions: [],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
      capabilities: READ_ONLY_CAPABILITIES,
    }),
  getChangeRequestActivity: () =>
    Effect.succeed({
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    }),
  getDiff: () => Effect.succeed({ patch: "", truncated: false, nextCursor: null }),
  runAction,
  updateChangeRequest: () => Effect.void,
  comment: () => Effect.void,
  updateComment: () => Effect.void,
  submitReview: () => Effect.void,
  replyToThread: () => Effect.void,
  setThreadResolution: () => Effect.void,
  setReaction: () => Effect.void,
  listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
  setReviewerRequest: () => Effect.void,
};

const service = PullRequestService.make.pipe(
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(PullRequestProviderRegistry, fromProviders([provider])),
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveHandle: () => Effect.die("Unexpected provider refinement"),
      }),
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [project],
            threads: [],
            updatedAt: "2026-08-02T00:00:00.000Z",
          }),
      }),
      SourceControlRateLimit.layer,
    ),
  ),
);

it.effect("carries the workspace probe's read-only capabilities through the RPC detail model", () =>
  Effect.gen(function* () {
    const pullRequests = yield* service;
    const detail = yield* pullRequests.detail({
      projectId: project.id,
      repository: "goldman/project",
      number: 42,
    });

    expect(detail.capabilities).toEqual(READ_ONLY_CAPABILITIES);
    expect(detail.viewer).toBe("coder-user");
  }),
);

it.effect("refuses a mutation when the fresh viewer permissions reflect a blocked workspace", () =>
  Effect.gen(function* () {
    runAction.mockClear();
    const pullRequests = yield* service;
    const error = yield* pullRequests
      .runAction({
        projectId: project.id,
        repository: "goldman/project",
        number: 42,
        action: "merge",
      })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
    expect(error.message).toContain("write access");
    expect(runAction).not.toHaveBeenCalled();
  }),
);

it.effect("publishes a refresh revision after a provider turn", () =>
  Effect.gen(function* () {
    const pullRequests = yield* service;
    const nextRefresh = yield* Stream.runHead(pullRequests.subscribeRefreshes).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;

    yield* pullRequests.refreshAfterTurn;

    expect(Option.getOrThrow(yield* Fiber.join(nextRefresh))).toBeGreaterThan(0);
  }),
);
