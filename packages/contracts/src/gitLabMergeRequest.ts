import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitLabMergeRequestViewInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
});
export type GitLabMergeRequestViewInput = typeof GitLabMergeRequestViewInput.Type;

export const GitLabMergeRequestActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type GitLabMergeRequestActor = typeof GitLabMergeRequestActor.Type;

export const GitLabMergeRequestPipeline = Schema.Struct({
  status: Schema.Literals([
    "pending",
    "running",
    "success",
    "failed",
    "cancelled",
    "skipped",
    "manual",
    "unknown",
  ]),
  url: Schema.NullOr(Schema.String),
});
export type GitLabMergeRequestPipeline = typeof GitLabMergeRequestPipeline.Type;

export const GitLabMergeRequestView = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  description: Schema.String,
  author: Schema.NullOr(GitLabMergeRequestActor),
  sourceBranch: TrimmedNonEmptyString,
  targetBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  mergeability: Schema.Literals(["mergeable", "conflicting", "checking", "unknown"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  reviewers: Schema.Array(GitLabMergeRequestActor),
  assignees: Schema.Array(GitLabMergeRequestActor),
  labels: Schema.Array(TrimmedNonEmptyString),
  changedFiles: NonNegativeInt,
  pipeline: Schema.NullOr(GitLabMergeRequestPipeline),
});
export type GitLabMergeRequestView = typeof GitLabMergeRequestView.Type;

export const GitLabMergeRequestViewResult = Schema.Struct({
  mergeRequest: Schema.NullOr(GitLabMergeRequestView),
});
export type GitLabMergeRequestViewResult = typeof GitLabMergeRequestViewResult.Type;

export const GitLabMergeRequestViewFailure = Schema.Literals([
  "workspace_not_owned_by_thread",
  "glab_unavailable",
  "glab_unauthenticated",
  "command_failed",
  "timed_out",
  "invalid_response",
]);
export type GitLabMergeRequestViewFailure = typeof GitLabMergeRequestViewFailure.Type;

export class GitLabMergeRequestViewError extends Schema.TaggedErrorClass<GitLabMergeRequestViewError>()(
  "GitLabMergeRequestViewError",
  {
    failure: GitLabMergeRequestViewFailure,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
