import {
  WS_METHODS,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestRef,
  type PullRequestDetail,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** Keep confirmed edits on the same cached reference regardless of input property order. */
function writableQueryFamily<A, E>(
  family: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const writable = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    Atom.writable(
      (get) => {
        const result = get(source);
        if (result._tag === "Success" && !result.waiting) return result;
        const previous = get.self<AsyncResult.AsyncResult<A, E>>();
        const value = Option.flatMap(previous, AsyncResult.value);
        if (Option.isNone(value)) return result;
        return result._tag === "Failure"
          ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
          : AsyncResult.success<A, E>(value.value, result);
      },
      (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
  return ({
    environmentId,
    input: { projectId, host, repository, number },
  }: Parameters<typeof family>[0]) =>
    writable(
      family({
        environmentId,
        input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
      }),
    );
}

/** Restart pre-mutation reads before patching so they cannot restore stale values. */
function updateCached<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  update: (value: A) => A,
  refresh = false,
) {
  if (refresh || registry.get(atom).waiting) registry.refresh(atom);
  registry.update(atom, AsyncResult.map(update));
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
}

/** Refresh a linked MR while its thread is visible so merges update the sidebar. */
export function createLinkedPullRequestDetailAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:linked-detail",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 15_000,
    refreshIntervalMs: 30_000,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

/** The host-native stack a pull request belongs to; null where it is not stacked. */
export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

/** GitLab merge-request reads and mutations scoped to one Coder environment. */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createPullRequestRefreshAtomFamily(runtime);
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  const detail = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      tag: WS_METHODS.pullRequestsDetail,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const activity = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:activity",
      tag: WS_METHODS.pullRequestsActivity,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const reviewerCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      staleTimeMs: 60_000,
    }),
  );

  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        input.cursors === undefined ? refreshes({ environmentId, input: {} }) : undefined,
    }),
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    detail,
    activity,
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      tag: WS_METHODS.pullRequestsDiff,
      staleTimeMs: 60_000,
    }),
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.cursor]),
      },
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    filesViewed: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:files-viewed",
      tag: WS_METHODS.pullRequestsFilesViewed,
      staleTimeMs: 15_000,
    }),
    /**
     * One write in flight per change request: the host applies these in order, and a reader
     * ticking down a file list faster than the round trip would otherwise race their own presses.
     */
    setFilesViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-files-viewed",
      tag: WS_METHODS.pullRequestsSetFilesViewed,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.repository, input.number]),
      },
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:run-action",
      tag: WS_METHODS.pullRequestsRunAction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    reviewerCandidates,
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { reviewers, requested } = target.input;
          const candidatesAtom = reviewerCandidates(target);
          const candidates = Option.getOrNull(AsyncResult.value(registry.get(candidatesAtom)));
          const selected =
            candidates?.candidates.filter((candidate) =>
              reviewers.some(
                (reviewer) => reviewer.id === candidate.id && reviewer.kind === candidate.kind,
              ),
            ) ?? [];
          const missingIdentities = selected.length < reviewers.length;
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              selected.includes(candidate) ? { ...candidate, isRequested: requested } : candidate,
            ),
          }));
          const selectedLogins = new Set(
            selected.map((candidate) => candidate.login.toLowerCase()),
          );
          const updateReviewers = (
            actors: ReadonlyArray<PullRequestActor>,
            keep = (_actor: PullRequestActor) => false,
          ) =>
            requested
              ? [
                  ...actors,
                  ...selected
                    .filter(
                      (candidate) =>
                        !actors.some(
                          (actor) => actor.login.toLowerCase() === candidate.login.toLowerCase(),
                        ),
                    )
                    .map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
                ]
              : actors.filter(
                  (actor) => !selectedLogins.has(actor.login.toLowerCase()) || keep(actor),
                );
          updateCached(
            registry,
            detail(target),
            (value) => ({
              ...value,
              reviewers: updateReviewers(value.reviewers),
            }),
            missingIdentities,
          );
          updateCached(
            registry,
            activity(target),
            (value) => ({
              ...value,
              reviewers:
                value.reviewers === undefined
                  ? undefined
                  : updateReviewers(value.reviewers, (actor) =>
                      value.comments.some(
                        (comment) =>
                          (comment.kind === "review" || comment.kind === "review-comment") &&
                          comment.author?.login.toLowerCase() === actor.login.toLowerCase(),
                      ),
                    ),
            }),
            missingIdentities,
          );
        }),
    }),
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
