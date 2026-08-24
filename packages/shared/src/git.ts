import type { VcsRef, VcsStatusResult, VcsStatusStreamEvent } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

export const WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^${WORKTREE_BRANCH_PREFIX}\\/(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`,
);

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return branchFragment.length > 0 ? branchFragment : "update";
}

export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");
  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;
  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(withoutPrefix)}`;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const separator = branchName.indexOf("/");
  return separator <= 0 || separator === branchName.length - 1
    ? branchName
    : branchName.slice(separator + 1);
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
): string {
  const token = randomHex(4)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function isTemporaryWorktreeBranch(refName: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(refName.trim().toLowerCase());
}

function localCandidates(ref: VcsRef): ReadonlyArray<string> {
  const candidates = new Set([deriveLocalBranchNameFromRemoteRef(ref.name)]);
  if (ref.remoteName) {
    const prefix = `${ref.remoteName}/`;
    if (ref.name.startsWith(prefix)) candidates.add(ref.name.slice(prefix.length));
  }
  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const locals = new Set(
    Arr.filterMap(refs, (ref) => (ref.isRemote ? Result.failVoid : Result.succeed(ref.name))),
  );
  return refs.filter(
    (ref) =>
      !ref.isRemote ||
      ref.remoteName !== "origin" ||
      !localCandidates(ref).some((candidate) => locals.has(candidate)),
  );
}

export function applyGitStatusStreamEvent(
  _current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  return event.local;
}
