import {
  WS_METHODS,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestActionInput,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestChecks,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type PullRequestMergeMethod,
  PullRequestOperationError,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  type QueryAnswerHandler,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { isStalePullRequestReply } from "../pullRequestReply.ts";
import { parsePullRequestQuery } from "../pullRequestQuery.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";

const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

// Coder: no `expectedAccountId`; the contract carries no cross-environment routing.
function normalizePullRequestQuery<A>(
  query: (target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef }) => A,
) {
  return ({
    environmentId,
    input: { projectId, host, repository, number, allowStale },
  }: Parameters<typeof query>[0]) =>
    query({
      environmentId,
      input: {
        projectId,
        ...(host === undefined ? {} : { host }),
        repository,
        number,
        ...(allowStale === undefined ? {} : { allowStale }),
      },
    });
}

function writableQuery<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  idleTtlMs = 5 * 60_000,
) {
  return Atom.writable(
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
  ).pipe(Atom.setIdleTTL(idleTtlMs));
}

function writableQueryFamily<A, E>(
  family: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const writable = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(source),
  );
  return normalizePullRequestQuery((target) => writable(family(target)));
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

interface ActionReplyPatch {
  /** The read this reader is waiting on, if any. */
  readonly pendingRead: (registry: AtomRegistry.AtomRegistry) => object | undefined;
  readonly apply: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    reply: PullRequestSummary | undefined,
    readsBeforeSend: ReadonlySet<object>,
  ) => Effect.Effect<void>;
}

// Module-wide so readers built by separate factories, such as linked summaries, are patched too.
const actionReplyPatches = new WeakMap<object, ActionReplyPatch>();

function samePullRequest(reader: PullRequestRef, acted: PullRequestRef) {
  return (
    reader.projectId === acted.projectId &&
    // A missing host is not a wildcard: one project can reach the same repository on two hosts.
    reader.host?.toLowerCase() === acted.host?.toLowerCase() &&
    reader.repository.toLowerCase() === acted.repository.toLowerCase() &&
    reader.number === acted.number
  );
}

function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: ReadonlyArray<K>,
): { [P in K]?: Exclude<T[P], undefined> } {
  const picked: { [P in K]?: T[P] } = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked as { [P in K]?: Exclude<T[P], undefined> };
}

function listAccepts(input: PullRequestListInput, state: string, isDraft: boolean | undefined) {
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  return (
    (input.state === "all" || input.state === state) &&
    (draft !== "only" || isDraft !== false) &&
    (draft !== "hide" || isDraft !== true)
  );
}

/**
 * Listing rows with an action's reply applied, the same array when it changes none, and `refresh`
 * when the reply adds the pull request to a listing, which only a read can place.
 */
export function patchPullRequestListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): ReadonlyArray<Entry> | "refresh" {
  let found = false;
  let changed = false;
  const patched = entries.flatMap((entry): Entry[] => {
    if (!samePullRequest(entry, reference)) return [entry];
    found = true;
    if (isStalePullRequestReply(entry, reply)) return [entry];
    changed = true;
    const next = {
      ...entry,
      ...pickDefined(reply, [
        "title",
        "url",
        "author",
        "headBranch",
        "baseBranch",
        "state",
        "isDraft",
        "mergeability",
        "updatedAt",
      ]),
    };
    return listAccepts(input, next.state, next.isDraft) ? [next] : [];
  });
  if (!found) {
    return input.cursors === undefined && listAccepts(input, reply.state, reply.isDraft)
      ? "refresh"
      : entries;
  }
  return changed
    ? patched.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : entries;
}

function patchListWithReply(
  input: PullRequestListInput,
  value: PullRequestListResult,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): PullRequestListResult | "refresh" {
  const entries = patchPullRequestListEntries(input, value.entries, reference, reply);
  if (entries === "refresh") return entries;
  return entries === value.entries ? value : { ...value, entries };
}

/**
 * The query atom for one target, writable so an action's reply can replace what it shows. The
 * patch is saved and announced the way an answer would be, so cold starts and snapshots see it.
 */
function actionPatchedQuery<Input, A, E>(
  source: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Input;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly label: string;
    readonly onAnswer?: QueryAnswerHandler<Input, A> | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly concerns: (input: Input, reference: PullRequestRef) => boolean;
    readonly patch: (
      input: Input,
      value: A,
      reference: PullRequestRef,
      reply: PullRequestSummary,
    ) => A | "refresh";
    /** Fields the reply lacks also changed, so the patched value shows while a read fetches them. */
    readonly rereads?: (value: A, reply: PullRequestSummary) => boolean;
    /** Re-read when the host's reply did not carry the pull request. */
    readonly rereadWithoutReply?: boolean;
    /** False for reads the refresh stream does not restart; defaults to true. */
    readonly refreshedByServer?: (input: Input) => boolean;
  },
) {
  const writable = Atom.family((atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(atom, options.idleTtlMs),
  );
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
    const query = source(target);
    const atom = writable(query);
    if (actionReplyPatches.has(atom)) return atom;
    const pendingRead = (registry: AtomRegistry.AtomRegistry) => {
      const result = Option.getOrUndefined(
        registry.getNodes().get(query)?.valueOption() ?? Option.none(),
      ) as AsyncResult.AsyncResult<A, E> | undefined;
      return result?.waiting === true ? result : undefined;
    };
    actionReplyPatches.set(atom, {
      pendingRead,
      apply: Effect.fnUntraced(
        function* (registry, environmentId, reference, reply, readsBeforeSend) {
          if (environmentId !== target.environmentId || !options.concerns(target.input, reference))
            return;
          const pending = pendingRead(registry);
          // A read sent before the action may miss its result, and so may one sent before the host
          // committed. The server's post-commit refresh restarts that one, but not a read outside
          // its stream, whose re-read need not even show as waiting, so a mounted one the reply
          // changes restarts here.
          const unrefreshed = options.refreshedByServer?.(target.input) === false;
          const freshRead = pending !== undefined && !unrefreshed && !readsBeforeSend.has(pending);
          const reread = () => (freshRead ? undefined : registry.refresh(atom));
          if (reply === undefined) {
            return options.rereadWithoutReply === true ? reread() : undefined;
          }
          const shown = Option.flatMap(
            registry.getNodes().get(atom)?.valueOption() ?? Option.none(),
            (current: AsyncResult.AsyncResult<A, E>) => AsyncResult.value(current),
          );
          if (Option.isNone(shown)) return reread();
          const patched = options.patch(target.input, shown.value, reference, reply);
          if (patched === "refresh") return reread();
          const lacking = options.rereads?.(shown.value, reply) === true;
          const next = reuseUnchanged(shown.value, patched);
          if (next === shown.value)
            return lacking || (unrefreshed && pending !== undefined) ? reread() : undefined;
          yield* options.onAnswer?.(target, next, registry) ?? Effect.void;
          const mounted = (registry.getNodes().get(atom)?.listeners.size ?? 0) > 0;
          if (!freshRead && (pending !== undefined || lacking || (unrefreshed && mounted)))
            registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map(() => next),
          );
        },
      ),
    });
    return atom;
  };
}

function makePullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
}

const refreshFamiliesByRuntime = new WeakMap<
  object,
  ReturnType<typeof makePullRequestRefreshAtomFamily>
>();

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
): ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>> {
  const existing = refreshFamiliesByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>>;
  const refreshes = makePullRequestRefreshAtomFamily(runtime);
  refreshFamiliesByRuntime.set(runtime, refreshes);
  return refreshes;
}

export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
  onAnswer?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>,
) {
  const label = "environment-data:pull-requests:linked-summary";
  return actionPatchedQuery(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label,
      tag: WS_METHODS.pullRequestsSummary,
      staleTimeMs: 60_000,
      refreshIntervalMs: 60_000,
      idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      isFinal: (summary) => summary.state === "merged",
      ...(onAnswer === undefined ? {} : { onAnswer }),
    }),
    {
      label,
      onAnswer,
      idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
      concerns: samePullRequest,
      // A routed action replies with the destination's project and repository names.
      patch: (_input, value, _reference, reply) =>
        isStalePullRequestReply(value, reply)
          ? value
          : {
              ...value,
              ...reply,
              projectId: value.projectId,
              repository: value.repository,
              number: value.number,
              ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
            },
    },
  );
}

/** Lets a client record what each answer says where it lands, rather than watching the data. */
export interface PullRequestAnswerHandlers {
  readonly list?: QueryAnswerHandler<PullRequestListInput, PullRequestListResult>;
  readonly listStats?: QueryAnswerHandler<PullRequestListStatsInput, PullRequestListStatsResult>;
  readonly detail?: QueryAnswerHandler<PullRequestRef, PullRequestDetail>;
  readonly checks?: QueryAnswerHandler<PullRequestRef, PullRequestChecks | null>;
  readonly reviewGuide?: QueryAnswerHandler<PullRequestRef, PullRequestReviewGuideResult>;
  /** Once per action reply, after the loaded readers show it; unscoped references only. */
  readonly actionReply?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>;
}

export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail | PullRequestSummary,
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

/**
 * Coder: upstream's offline query persistence (`persistQuery`, mobile's store) is not carried,
 * so these queries stay in memory.
 */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  onAnswer: PullRequestAnswerHandlers = {},
) {
  const refreshes = createPullRequestRefreshAtomFamily(runtime);
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:activity",
      tag: WS_METHODS.pullRequestsActivity,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const detailAnswerAtoms = Atom.family((_key: string) =>
    Atom.make<{ readonly value: PullRequestDetail; readonly version: number } | null>(null).pipe(
      Atom.setIdleTTL(5 * 60_000),
    ),
  );
  const detailAnswers = normalizePullRequestQuery((target) =>
    detailAnswerAtoms(JSON.stringify(target)),
  );
  const detailLabel = "environment-data:pull-requests:detail";
  const detail = normalizePullRequestQuery(
    actionPatchedQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: detailLabel,
        tag: WS_METHODS.pullRequestsDetail,
        staleTimeMs: 60_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        onAnswer: (target, value, registry) =>
          Effect.sync(() => {
            // Cache reads bypass onAnswer, and server freshness stays separate from local readbacks.
            registry.update(detailAnswers(target), (previous) => ({
              value,
              version: (previous?.version ?? 0) + 1,
            }));
          }).pipe(Effect.andThen(() => onAnswer.detail?.(target, value, registry) ?? Effect.void)),
      }),
      {
        label: detailLabel,
        onAnswer: onAnswer.detail,
        concerns: samePullRequest,
        rereadWithoutReply: true,
        // Reopening or a new head changes branch data and permissions the reply lacks.
        rereads: (value, reply) =>
          !isStalePullRequestReply(value, reply) &&
          ((value.state === "closed" && reply.state === "open") ||
            (reply.headSha !== undefined && reply.headSha !== value.headSha)),
        patch: (_input, value, _reference, reply) => {
          if (isStalePullRequestReply(value, reply)) return value;
          const patched = {
            ...value,
            ...pickDefined(reply, [
              "title",
              "url",
              "author",
              "state",
              "isDraft",
              "mergeability",
              "additions",
              "deletions",
              "changedFiles",
              "headBranch",
              "baseBranch",
              "updatedAt",
              "mergedAt",
              "closedAt",
              "autoMergeEnabled",
              "autoMergeMethod",
            ]),
          };
          if (reply.autoMergeEnabled !== false) return patched;
          const { autoMergeMethod: _disarmed, ...withoutAutoMerge } = patched;
          return withoutAutoMerge;
        },
      },
    ),
  );
  // Pages read the strict detail and other surfaces the default one; patch whichever is loaded
  // without starting a read of the other.
  const loadedDetails = (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
  ) =>
    [
      detail({ ...target, input: { ...target.input, allowStale: undefined } }),
      detail({ ...target, input: { ...target.input, allowStale: false } }),
    ].filter((atom) => registry.getNodes().has(atom));
  const detailReadVersions = Atom.family((source: ReturnType<typeof detail>) =>
    Atom.family((answer: ReturnType<typeof detailAnswers>) =>
      Atom.make((get) => {
        const result = get(source);
        const latest = get(answer);
        return result._tag === "Success" && !result.waiting && result.value === latest?.value
          ? latest.version
          : Option.getOrElse(get.self<number>(), () => 0);
      }).pipe(Atom.setIdleTTL(5 * 60_000)),
    ),
  );
  const detailReadVersion = normalizePullRequestQuery((target) =>
    detailReadVersions(detail(target))(detailAnswers(target)),
  );
  const previewQuery = (label: string) =>
    normalizePullRequestQuery(
      actionPatchedQuery(
        createEnvironmentRpcQueryAtomFamily(runtime, {
          label,
          tag: WS_METHODS.pullRequestsPreview,
          staleTimeMs: 60_000,
          refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        }),
        {
          label,
          concerns: samePullRequest,
          rereadWithoutReply: true,
          // Servers before action replies send unstamped previews, which only a read can order.
          patch: (_input, value, _reference, reply) =>
            value.updatedAt === undefined && value.observedAt === undefined
              ? "refresh"
              : isStalePullRequestReply(value, reply)
                ? value
                : {
                    ...value,
                    ...pickDefined(reply, [
                      "title",
                      "url",
                      "author",
                      "state",
                      "isDraft",
                      "updatedAt",
                      "observedAt",
                    ]),
                  },
        },
      ),
    );
  const preview = previewQuery("environment-data:pull-requests:preview");
  // Hover cards read their own atoms, so a pending or failed hover read never decides where a
  // click on the same link goes.
  const previewCard = previewQuery("environment-data:pull-requests:preview-card");
  const labelCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      tag: WS_METHODS.pullRequestsLabelCandidates,
      staleTimeMs: 60_000,
    }),
  );
  const reviewGuide = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:review-guide",
      tag: WS_METHODS.pullRequestsReviewGuide,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.reviewGuide === undefined ? {} : { onAnswer: onAnswer.reviewGuide }),
    }),
  );
  const reviewerCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      staleTimeMs: 60_000,
    }),
  );
  // Asked only when the menu's first page is not everybody, so a query cannot be answered from it.
  const reviewerSearch = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:reviewer-search",
    tag: WS_METHODS.pullRequestsReviewerCandidates,
    staleTimeMs: 60_000,
  });

  const runAction = Effect.fn("PullRequests.runAction")(function* (
    input: PullRequestActionInput & {
      readonly resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
    },
  ) {
    const { resolveMergeMethod, ...actionInput } = input;
    let preparedInput = actionInput;
    if (actionInput.action === "merge" && resolveMergeMethod !== undefined) {
      const { projectId, host, repository, number } = actionInput;
      const reference = { projectId, host, repository, number, allowStale: false };
      const detail = yield* requestGuarded(WS_METHODS.pullRequestsDetail, reference);
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        return yield* new PullRequestOperationError({
          operation: "runAction",
          detail: "This merge request cannot be merged.",
        });
      }
      if (detail.capabilities.stackActions) {
        const stack = yield* requestGuarded(WS_METHODS.pullRequestsStack, reference);
        if (stack !== null) {
          return yield* new PullRequestOperationError({
            operation: "runAction",
            detail: "Open this merge request to merge its stack.",
          });
        }
      }
      const mergeMethod = yield* Effect.try({
        try: () => resolveMergeMethod(detail),
        catch: (cause) =>
          new PullRequestOperationError({
            operation: "runAction",
            detail: cause instanceof Error ? cause.message : "Could not choose a merge method.",
          }),
      });
      preparedInput = { ...actionInput, mergeMethod };
    }
    return yield* requestGuarded(WS_METHODS.pullRequestsRunAction, {
      ...preparedInput,
      replyWithSummary: true,
    });
  });
  const actionReplyReaders = (registry: AtomRegistry.AtomRegistry) =>
    Array.from(registry.getNodes().keys()).flatMap((atom) => {
      const patch = typeof atom === "string" ? undefined : actionReplyPatches.get(atom);
      return patch === undefined ? [] : [patch];
    });
  const readsInFlight = (registry: AtomRegistry.AtomRegistry): ReadonlySet<object> =>
    new Set(actionReplyReaders(registry).flatMap((reader) => reader.pendingRead(registry) ?? []));
  const applyActionReply = Effect.fn("PullRequests.applyActionReply")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    reply: PullRequestSummary | undefined,
    readsBeforeSend: ReadonlySet<object>,
  ) {
    for (const reader of actionReplyReaders(registry)) {
      yield* reader.apply(registry, environmentId, reference, reply, readsBeforeSend);
    }
    if (reply !== undefined) {
      yield* (
        onAnswer.actionReply?.({ environmentId, input: reference }, reply, registry) ?? Effect.void
      );
    }
  });
  const listLabel = "environment-data:pull-requests:list";

  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    // For callers that open a thread from the answer: a persisted one reads as final before
    // the connection is known, and a kept one can predate the thread.
    linkedThreadsUncached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads-uncached",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list: actionPatchedQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: listLabel,
        tag: WS_METHODS.pullRequestsList,
        staleTimeMs: 30_000,
        refreshTrigger: ({ environmentId, input }) =>
          input.cursors === undefined ? refreshes({ environmentId, input: {} }) : undefined,
        ...(onAnswer.list === undefined ? {} : { onAnswer: onAnswer.list }),
      }),
      {
        label: listLabel,
        onAnswer: onAnswer.list,
        // Rows carry no account scope, so a reply read through another account leaves them alone.
        concerns: (input, reference) =>
          (input.projectId === undefined || input.projectId === reference.projectId) &&
          (input.projectIds === undefined || input.projectIds.includes(reference.projectId)) &&
          (input.host === undefined ||
            reference.host === undefined ||
            input.host.toLowerCase() === reference.host.toLowerCase()),
        refreshedByServer: (input) => input.cursors === undefined,
        patch: patchListWithReply,
      },
    ),
    /**
     * Its own query because the listing is quicker without them — measured over twelve
     * repositories, ~4.0s against ~7.1s — so the rows arrive first and their stats a moment
     * later.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.listStats === undefined ? {} : { onAnswer: onAnswer.listStats }),
    }),
    filterOptions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:filter-options",
      tag: WS_METHODS.pullRequestsFilterOptions,
      staleTimeMs: 5 * 60_000,
    }),
    detail,
    detailReadVersion,
    preview,
    previewCard,
    checks: normalizePullRequestQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:checks",
        tag: WS_METHODS.pullRequestsChecks,
        staleTimeMs: 45_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        ...(onAnswer.checks === undefined ? {} : { onAnswer: onAnswer.checks }),
      }),
    ),
    activity,
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
    // Coder loads the diff over the helper's stdio RPC; there is no environment HTTP endpoint.
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      tag: WS_METHODS.pullRequestsDiff,
      staleTimeMs: 60_000,
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
    changeBreakdown: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:change-breakdown",
      tag: WS_METHODS.pullRequestsChangeBreakdown,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
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
      tag: WS_METHODS.pullRequestsRunAction,
      label: "environment-data:pull-requests:run-action",
      // Preparation belongs to the write's lane. Refreshable queries would restart it after
      // every preceding action, and preparing outside the lane could reorder the clicks.
      execute: runAction,
      onStart: (_target, registry) => readsInFlight(registry),
      // Loaded readers show the reply, or re-read when the host's reply lacked the pull request.
      onSuccess: ({ environmentId, input }, registry, reply, readsBeforeSend) => {
        const { projectId, host, repository, number } = input;
        return applyActionReply(
          registry,
          environmentId,
          {
            projectId,
            ...(host === undefined ? {} : { host }),
            repository,
            number,
          },
          reply,
          readsBeforeSend ?? new Set(),
        );
      },
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      onSuccess: (target, registry) => Effect.sync(() => registry.refresh(preview(target))),
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
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
        ),
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
    /** The host's search for reviewers past the first page, keyed by what was typed. */
    reviewerSearch,
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { reviewers, requested } = target.input;
          const candidatesAtom = reviewerCandidates(target);
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
          const selected =
            candidates?.candidates.filter((candidate) =>
              reviewers.some(
                (reviewer) => reviewer.id === candidate.id && reviewer.kind === candidate.kind,
              ),
            ) ?? [];
          const missingIdentities = selected.length < reviewers.length;
          // Somebody found only by the host's search is not in the loaded list yet; the host
          // puts requested reviewers first, so reading it again brings them in.
          updateCached(
            registry,
            candidatesAtom,
            (value) => ({
              ...value,
              candidates: value.candidates.map((candidate) =>
                selected.includes(candidate) ? { ...candidate, isRequested: requested } : candidate,
              ),
            }),
            missingIdentities,
          );
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
          for (const atom of loadedDetails(registry, target)) {
            updateCached(
              registry,
              atom,
              (value) => ({
                ...value,
                reviewers: updateReviewers(value.reviewers),
              }),
              missingIdentities,
            );
          }
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
    reviewGuide,
    generateReviewGuide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:generate-review-guide",
      tag: WS_METHODS.pullRequestsGenerateReviewGuide,
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          updateCached(registry, reviewGuide(target), () => result, true);
        }),
    }),
    labelCandidates,
    setLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-labels",
      tag: WS_METHODS.pullRequestsSetLabels,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { labels, applied } = target.input;
          const candidatesAtom = labelCandidates(target);
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
          const names = new Set(labels);
          updateCached(registry, candidatesAtom, (value) => ({
            ...value,
            candidates: value.candidates.map((candidate) =>
              names.has(candidate.name) ? { ...candidate, isApplied: applied } : candidate,
            ),
          }));
          for (const atom of loadedDetails(registry, target)) {
            updateCached(registry, atom, (value) => ({
              ...value,
              labels: applied
                ? [
                    ...value.labels,
                    ...labels
                      .filter((name) => !value.labels.some((label) => label.name === name))
                      .map((name) => ({
                        name,
                        color:
                          candidates?.candidates.find((candidate) => candidate.name === name)
                            ?.color ?? null,
                      })),
                  ]
                : value.labels.filter((label) => !names.has(label.name)),
            }));
          }
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
    /**
     * A separate request rather than a flag on a read, so only a person's refresh spends
     * host requests while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          if (input.reference !== undefined) {
            registry.refresh(preview({ environmentId, input: input.reference }));
            registry.refresh(previewCard({ environmentId, input: input.reference }));
          }
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
