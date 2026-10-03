import type { AnimationEvent, MouseEvent, ReactElement } from "react";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "../lib/utils";
import {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";
import {
  PULL_REQUEST_STATE_PRESENTATION,
  PullRequestGlyph,
  PullRequestGlyphIcon,
} from "./pullRequest/pullRequestIcons";
import { parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import type {
  ThreadPullRequestLink,
  EnvironmentId,
  ThreadLinkedPullRequest,
  VcsStatusResult,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { CloudIcon, FolderGit2Icon, TerminalIcon } from "lucide-react";
import { useMemo } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironment } from "../state/environments";
import { useActiveEnvironmentId, useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom } from "../state/pullRequests";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  Icon: PullRequestGlyphIcon;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  if (parseChangeRequestUrl(link.url) === null) return null;
  const kind = "gitlab";
  return {
    pr: {
      number: link.number,
      url: link.url,
      title: snapshot.title,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      headRef: snapshot.headBranch,
      baseRef: snapshot.baseBranch,
      ...(snapshot.updatedAt === null ? {} : { updatedAt: snapshot.updatedAt }),
    },
    sourceControlProvider: { kind, name: kind, baseUrl: "" },
  };
}

export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
): LinkedThreadPullRequestStatus | null {
  const current = resolveThreadCurrentPullRequestLink(pullRequests ?? []);
  const detail = useEnvironmentQuery(
    current !== null || environmentId === null || linkedPullRequest == null
      ? null
      : linkedPullRequestDetailAtom({
          environmentId,
          input: {
            ...(parseChangeRequestUrl(linkedPullRequest.url)?.host
              ? { host: parseChangeRequestUrl(linkedPullRequest.url)!.host }
              : {}),
            projectId: linkedPullRequest.projectId,
            repository: linkedPullRequest.repository,
            number: linkedPullRequest.number,
          },
        }),
  ).data;

  return useMemo(
    () =>
      current !== null
        ? linkedPullRequestSnapshotStatus(current)
        : detail === null
          ? null
          : {
              pr: pullRequestDetailToVcsStatus(detail),
              sourceControlProvider: {
                kind: detail.provider,
                name: detail.provider,
                baseUrl: "",
              },
            },
    [current, detail],
  );
}

export function settledPrHoverColorClass(
  state: NonNullable<ThreadPr>["state"],
  isDraft = false,
): string {
  switch (state) {
    case "open":
      if (isDraft) {
        return "group-hover/sidebar-row:text-zinc-500 dark:group-hover/sidebar-row:text-zinc-400/80";
      }
      return "group-hover/sidebar-row:text-emerald-600 dark:group-hover/sidebar-row:text-emerald-300/90";
    case "merged":
      return "group-hover/sidebar-row:text-violet-600 dark:group-hover/sidebar-row:text-violet-300/90";
    case "closed":
      return "group-hover/sidebar-row:text-red-600 dark:group-hover/sidebar-row:text-red-300/90";
  }
}

export {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestGlyphIcon;
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

/** Resolve the complete badge appearance before rendering it in the sidebar or composer. */
export function resolveThreadPullRequestBadgePresentation({
  badge,
  number,
  url,
  status,
}: {
  readonly badge: ThreadPullRequestBadge | null;
  readonly number?: number | undefined;
  readonly url?: string | undefined;
  readonly status: PrStatusIndicator | null;
}): ThreadPullRequestBadgePresentation | null {
  // The badge already folds every visible link into one state, draft included, so both the
  // stack and the linked count index the shared table directly rather than the single-PR resolver.
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} merge requests, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip = status?.tooltip ?? `MR !${number}, status pending`;
  if (badge?.kind === "pull-request" && badge.others > 0) {
    // Unrelated links fold into one state, so a count of merged PRs reads as merged.
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: `${tooltip}, and ${badge.others} more linked; overall ${aggregate.label.toLowerCase()}`,
      text: `+${badge.others + 1}`,
    };
  }
  return {
    Icon: status?.Icon ?? PullRequestGlyph.pullRequest,
    toneClassName: status?.colorClass ?? "text-muted-foreground",
    label: tooltip,
    text: number,
  };
}

/**
 * The linked-PR badge shared by the sidebar and composer footer. The badge owns what it shows:
 * the state glyph and number at the meta size, in the state's color. The caller owns the control
 * it sits in through `render` (an inline link in a sidebar row, a toolbar control in the
 * composer), and the badge fills in the behavior: a single PR is a link to it, while a stack or
 * several linked PRs is a button that opens the thread's pull requests tab.
 */
export function ThreadPullRequestBadgeControl({
  render,
  badge,
  number,
  url,
  status,
  onOpenList,
  onOpenPullRequest,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  badge: ThreadPullRequestBadge | null;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>) => void;
}) {
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
  if (presentation === null) return null;
  return (
    <PullRequestBadge
      render={render}
      presentation={presentation}
      opensList={badge !== null && (badge.kind === "stack" || badge.others > 0)}
      url={url}
      onOpenList={onOpenList}
      onOpenPullRequest={onOpenPullRequest}
    />
  );
}

function PullRequestBadge({
  render,
  presentation,
  opensList,
  url,
  onOpenList,
  onOpenPullRequest,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  presentation: NonNullable<ReturnType<typeof resolveThreadPullRequestBadgePresentation>>;
  opensList: boolean;
  url: string | undefined;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>) => void;
}) {
  const onClick = opensList
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenList();
      }
    : onOpenPullRequest;
  const element = opensList ? (
    <button type="button" />
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" />
  );
  // The caller's control (InlineButton, ComposerControl) renders as the link or stack button
  // through its own render prop; useRender merges the badge's behavior into it.
  const control = useRender({
    render,
    props: {
      render: element,
      "aria-label": presentation.label,
      onPointerDown: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
      onClick,
    },
  });
  return (
    <Tooltip>
      <TooltipTrigger render={control}>
        <span
          className={cn("contents font-normal text-xs tabular-nums", presentation.toneClassName)}
        >
          <presentation.Icon aria-hidden className="size-3 shrink-0" />
          {/* An element, not bare text: bare text takes its line box from the control, which
              inherits the row's size, so beside a text-sm title it sat below the other meta. */}
          <span>{presentation.text}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true });

  const tooltipLead = `${presentation.shortName} #${pr.number} - ${state.label}`;
  return {
    label: `${presentation.shortName} ${state.label.toLowerCase()}`,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: `${tooltipLead}: ${pr.title}`,
    tooltipLead,
    tooltipTitle: pr.title,
    url: pr.url,
  };
}

export function ChangeRequestStatusIcon({
  state,
  isDraft = false,
  className,
}: Pick<NonNullable<ThreadPr>, "state"> & {
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const presentation = resolvePullRequestState({ state, isDraft });
  return <presentation.Icon className={className} />;
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
}

export function resolveThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): ThreadPr | null {
  const { threadBranch, gitStatus } = input;
  if (gitStatus === null) {
    return null;
  }

  if (threadBranch === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

/**
 * Parent-held PR snapshot for Sidebar V2. Rows remount when settlement
 * partitions move them, so terminal PR metadata must live above the row.
 */
export interface ThreadChangeRequestSnapshot {
  readonly branch: string;
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: VcsStatusResult["sourceControlProvider"] | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest;
}

export const threadChangeRequestSnapshotsAtom = Atom.make<
  ReadonlyMap<string, ThreadChangeRequestSnapshot>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("sidebar:thread-change-request-snapshots"));

function isTerminalChangeRequestState(
  state: NonNullable<ThreadPr>["state"],
): state is "merged" | "closed" {
  return state === "merged" || state === "closed";
}

function sourceControlProvidersEqual(
  left: VcsStatusResult["sourceControlProvider"] | undefined,
  right: VcsStatusResult["sourceControlProvider"] | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  return left.kind === right.kind && left.name === right.name && left.baseUrl === right.baseUrl;
}

function linkedPullRequestsEqual(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.number === right.number &&
    left.url === right.url
  );
}

export function threadChangeRequestSnapshotsEqual(
  left: ThreadChangeRequestSnapshot,
  right: ThreadChangeRequestSnapshot,
): boolean {
  return (
    left.branch === right.branch &&
    left.pr.number === right.pr.number &&
    left.pr.title === right.pr.title &&
    left.pr.url === right.pr.url &&
    left.pr.baseRef === right.pr.baseRef &&
    left.pr.headRef === right.pr.headRef &&
    left.pr.state === right.pr.state &&
    left.pr.isDraft === right.pr.isDraft &&
    (left.pr.updatedAt ?? null) === (right.pr.updatedAt ?? null) &&
    sourceControlProvidersEqual(left.sourceControlProvider, right.sourceControlProvider) &&
    linkedPullRequestsEqual(left.linkedPullRequest, right.linkedPullRequest)
  );
}

export function setThreadChangeRequestSnapshot(
  threadKey: string,
  snapshot: ThreadChangeRequestSnapshot | null,
): void {
  appAtomRegistry.modify(threadChangeRequestSnapshotsAtom, (current) => {
    const existing = current.get(threadKey);
    if (snapshot === null) {
      if (existing === undefined) return [false, current];
      const next = new Map(current);
      next.delete(threadKey);
      return [true, next];
    }
    if (existing !== undefined && threadChangeRequestSnapshotsEqual(existing, snapshot)) {
      return [false, current];
    }
    const next = new Map(current);
    next.set(threadKey, snapshot);
    return [true, next];
  });
}

/**
 * Authoritative snapshot update from live VCS status.
 * - `undefined`: missing status, or a local checkout retaining a terminal PR — leave the map alone
 * - `null`: no PR (without a retained terminal snapshot), a cleared branch, or a mismatch without a terminal PR — clear
 * - snapshot: matching branch reports a PR — store/replace
 */
export function nextThreadChangeRequestSnapshot(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadChangeRequestSnapshot | null | undefined {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  // Multi-link status is already durable. Do not cache another repository's MR
  // under the legacy link, where it could survive unlinking the selected MR.
  if (
    linkedPullRequestStatus != null &&
    linkedPullRequestStatus.pr.url !== linkedPullRequest?.url
  ) {
    return null;
  }
  if (linkedPullRequest != null) {
    if (linkedPullRequestStatus === null || linkedPullRequestStatus === undefined) {
      return linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
        ? undefined
        : null;
    }
    return {
      branch: threadBranch ?? linkedPullRequestStatus.pr.headRef,
      pr: linkedPullRequestStatus.pr,
      sourceControlProvider: linkedPullRequestStatus.sourceControlProvider,
      linkedPullRequest,
    };
  }
  if (gitStatus === null) {
    return snapshot?.linkedPullRequest === undefined ? undefined : null;
  }
  if (threadBranch === null) {
    return null;
  }
  if (gitStatus.refName !== threadBranch) {
    return retainTerminalOnBranchMismatch &&
      snapshot != null &&
      snapshot.linkedPullRequest === undefined &&
      isTerminalChangeRequestState(snapshot.pr.state)
      ? undefined
      : null;
  }
  if (gitStatus.pr == null) {
    if (
      retainTerminalOnBranchMismatch &&
      snapshot != null &&
      snapshot.linkedPullRequest === undefined &&
      isTerminalChangeRequestState(snapshot.pr.state)
    ) {
      return undefined;
    }
    return null;
  }
  return {
    branch: threadBranch,
    pr: gitStatus.pr,
    sourceControlProvider: gitStatus.sourceControlProvider,
  };
}

/**
 * Live PR when the checkout matches the thread branch; otherwise, for local
 * checkouts only, a cached merged/closed PR for the thread. Local thread
 * metadata follows the shared checkout, so the cached branch intentionally
 * survives that metadata changing to the newly checked-out branch. Open PRs
 * are never retained — their state can still change.
 */
export function resolveDisplayedThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadPr | null {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  if (linkedPullRequestStatus != null) return linkedPullRequestStatus.pr;
  if (linkedPullRequest != null) {
    return linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
      ? (snapshot?.pr ?? null)
      : null;
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.pr;
  }

  if (
    threadBranch !== null &&
    retainTerminalOnBranchMismatch &&
    snapshot != null &&
    snapshot.linkedPullRequest === undefined &&
    isTerminalChangeRequestState(snapshot.pr.state)
  ) {
    return snapshot.pr;
  }

  return null;
}

export function resolveDisplayedThreadPrProvider(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): VcsStatusResult["sourceControlProvider"] | undefined {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  if (linkedPullRequestStatus != null) return linkedPullRequestStatus.sourceControlProvider;
  if (linkedPullRequest != null) {
    return linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
      ? snapshot?.sourceControlProvider
      : undefined;
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.sourceControlProvider;
  }

  if (
    threadBranch !== null &&
    retainTerminalOnBranchMismatch &&
    snapshot != null &&
    snapshot.linkedPullRequest === undefined &&
    isTerminalChangeRequestState(snapshot.pr.state)
  ) {
    return snapshot.sourceControlProvider;
  }

  return undefined;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

/** Align newly started pulses with the document clock without a timer or frame loop. */
export function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const linkedPullRequest = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    thread.pullRequests,
  );
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null &&
      (thread.branch != null || thread.worktreePath !== null) &&
      gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const pr =
    thread.linkedPullRequest == null
      ? resolveThreadPr({ threadBranch: thread.branch, gitStatus: gitStatus.data })
      : (linkedPullRequest?.pr ?? null);
  const prStatus = prStatusIndicator(
    pr,
    linkedPullRequest?.sourceControlProvider ?? gitStatus.data?.sourceControlProvider,
  );
  const currentLink = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const badgePresentation = resolveThreadPullRequestBadgePresentation({
    badge: resolveThreadPullRequestBadge(thread.pullRequests),
    number: pr?.number ?? currentLink?.number,
    url: pr?.url ?? currentLink?.url,
    status: prStatus,
  });
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!badgePresentation && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {badgePresentation ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgePresentation.label}
                role="img"
                className={`inline-flex items-center justify-center ${badgePresentation.toneClassName}`}
              />
            }
          >
            <badgePresentation.Icon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{badgePresentation.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const activeEnvironmentId = useActiveEnvironmentId();
  const isRemoteThread =
    activeEnvironmentId !== null && thread.environmentId !== activeEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
              onAnimationStart={synchronizeTerminalPulse}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
