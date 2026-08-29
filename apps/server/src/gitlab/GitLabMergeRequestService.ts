import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitLabMergeRequestViewError,
  type GitLabMergeRequestActor,
  type GitLabMergeRequestPipeline,
  type GitLabMergeRequestView,
  type GitLabMergeRequestViewResult,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const DESCRIPTION_MAX_LENGTH = 256 * 1024;
const LABEL_MAX_COUNT = 100;
const ACTOR_MAX_COUNT = 100;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (result === null) throw new Error(`Missing ${field}.`);
  return result;
}

function actor(value: unknown): GitLabMergeRequestActor | null {
  const raw = record(value);
  if (raw === null) return null;
  const login = optionalString(raw.username);
  if (login === null) return null;
  return {
    login,
    name: optionalString(raw.name),
    avatarUrl: optionalString(raw.avatar_url),
  };
}

function actors(value: unknown): ReadonlyArray<GitLabMergeRequestActor> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, ACTOR_MAX_COUNT).flatMap((entry) => {
    const decoded = actor(entry);
    return decoded === null ? [] : [decoded];
  });
}

function labels(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LABEL_MAX_COUNT).flatMap((entry) => {
    const decoded = optionalString(entry);
    return decoded === null ? [] : [decoded];
  });
}

function state(raw: UnknownRecord): GitLabMergeRequestView["state"] {
  if (optionalString(raw.merged_at) !== null) return "merged";
  const value = optionalString(raw.state)?.toLowerCase();
  return value === "merged" ? "merged" : value === "closed" ? "closed" : "open";
}

function mergeability(raw: UnknownRecord): GitLabMergeRequestView["mergeability"] {
  if (raw.has_conflicts === true) return "conflicting";
  switch (optionalString(raw.merge_status)?.toLowerCase()) {
    case "can_be_merged":
    case "mergeable":
      return "mergeable";
    case "cannot_be_merged":
    case "cannot_be_merged_recheck":
      return "conflicting";
    case "checking":
    case "unchecked":
      return "checking";
    default:
      return "unknown";
  }
}

function pipelineStatus(value: unknown): GitLabMergeRequestPipeline["status"] {
  switch (optionalString(value)?.toLowerCase()) {
    case "pending":
    case "created":
    case "preparing":
    case "waiting_for_resource":
      return "pending";
    case "running":
      return "running";
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
    case "scheduled":
      return "manual";
    default:
      return "unknown";
  }
}

function pipeline(value: unknown): GitLabMergeRequestPipeline | null {
  const raw = record(value);
  if (raw === null) return null;
  return {
    status: pipelineStatus(raw.status),
    url: optionalString(raw.web_url),
  };
}

function changedFiles(value: unknown): number {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function decodeGitLabMergeRequestView(rawJson: string): GitLabMergeRequestView {
  const raw = record(JSON.parse(rawJson));
  if (raw === null) throw new Error("Expected an object.");
  const number = raw.iid;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error("Missing iid.");
  }

  return {
    number,
    title: requiredString(raw.title, "title"),
    url: requiredString(raw.web_url, "web_url"),
    description:
      typeof raw.description === "string" ? raw.description.slice(0, DESCRIPTION_MAX_LENGTH) : "",
    author: actor(raw.author),
    sourceBranch: requiredString(raw.source_branch, "source_branch"),
    targetBranch: requiredString(raw.target_branch, "target_branch"),
    state: state(raw),
    isDraft: raw.draft === true || raw.work_in_progress === true,
    mergeability: mergeability(raw),
    createdAt: requiredString(raw.created_at, "created_at"),
    updatedAt: requiredString(raw.updated_at, "updated_at"),
    mergedAt: optionalString(raw.merged_at),
    closedAt: optionalString(raw.closed_at),
    reviewers: actors(raw.reviewers),
    assignees: actors(raw.assignees),
    labels: labels(raw.labels),
    changedFiles: changedFiles(raw.changes_count),
    pipeline: pipeline(raw.head_pipeline),
  };
}

function processError(error: VcsError): GitLabMergeRequestViewError {
  if (error._tag === "VcsProcessSpawnError") {
    return new GitLabMergeRequestViewError({
      failure: "glab_unavailable",
      detail: "GitLab CLI (`glab`) is not available in this workspace.",
    });
  }
  if (error._tag === "VcsProcessTimeoutError") {
    return new GitLabMergeRequestViewError({
      failure: "timed_out",
      detail: "GitLab took too long to load the merge request.",
    });
  }
  return new GitLabMergeRequestViewError({
    failure: "command_failed",
    detail: "GitLab CLI could not load the merge request.",
  });
}

function isNoMergeRequestError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("no merge request") ||
    normalized.includes("could not find merge request") ||
    normalized.includes("merge request not found")
  );
}

function isAuthenticationError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("glab auth login") ||
    normalized.includes("not authenticated") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication required")
  );
}

export class GitLabMergeRequestService extends Context.Service<
  GitLabMergeRequestService,
  {
    readonly viewCurrent: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitLabMergeRequestViewResult, GitLabMergeRequestViewError>;
  }
>()("t3/gitlab/GitLabMergeRequestService") {}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const viewCurrent = Effect.fn("GitLabMergeRequestService.viewCurrent")(function* (input: {
    readonly cwd: string;
  }) {
    const output = yield* process
      .run({
        operation: "GitLabMergeRequestService.viewCurrent",
        command: "glab",
        args: ["mr", "view", "--output", "json"],
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.mapError(processError));

    if (output.exitCode !== 0) {
      if (isNoMergeRequestError(output.stderr)) return { mergeRequest: null };
      if (isAuthenticationError(output.stderr)) {
        return yield* new GitLabMergeRequestViewError({
          failure: "glab_unauthenticated",
          detail: "GitLab CLI is not authenticated. Run `glab auth login` in the workspace.",
        });
      }
      return yield* new GitLabMergeRequestViewError({
        failure: "command_failed",
        detail: "GitLab CLI could not load a merge request for the current branch.",
      });
    }

    if (output.stdoutTruncated || output.stdoutInvalidUtf8) {
      return yield* new GitLabMergeRequestViewError({
        failure: "invalid_response",
        detail: "GitLab returned a merge request response that could not be read safely.",
      });
    }

    return yield* Effect.try({
      try: () => ({ mergeRequest: decodeGitLabMergeRequestView(output.stdout) }),
      catch: () =>
        new GitLabMergeRequestViewError({
          failure: "invalid_response",
          detail: "GitLab returned an invalid merge request response.",
        }),
    });
  });

  return GitLabMergeRequestService.of({ viewCurrent });
});

export const layer = Layer.effect(GitLabMergeRequestService, make);
