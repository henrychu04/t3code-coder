import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  MAX_REVIEW_DIFF_FILE_BYTES,
  ReviewDiffFileTooLargeError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffFileError,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsRefStatusResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@t3tools/shared/git";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitMoveWorktreeInput {
  cwd: string;
  oldPath: string;
  newPath: string;
}

export interface GitPushResult {
  readonly branch: string;
  readonly upstreamBranch: string | null;
  readonly setUpstream: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly ensureRemote: (input: {
      readonly cwd: string;
      readonly preferredName: string;
      readonly url: string;
    }) => Effect.Effect<string, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      branch: string | null,
      options?: { readonly remoteName?: string; readonly progress?: ExecuteGitProgress },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly refStatusLocal: (cwd: string) => Effect.Effect<VcsRefStatusResult, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffFileError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Drops worktree admin entries whose directory is already gone (`git worktree prune`). */
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly moveWorktree: (input: GitMoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_UNTRACKED_PATHS_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000;
// Rendered patches are parsed using Git's conventional a/ and b/ path prefixes.
// Override repository or global prefix settings so paths remain parseable.
const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

interface Trace2TailState {
  readonly processedChars: number;
  readonly remainder: string;
}

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") return String(childId);
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim() ? hookName.trim() : null;
}

const createTrace2Monitor = Effect.fn("GitVcsDriver.createTrace2Monitor")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  progress: ExecuteGitProgress | undefined,
) {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return { env: {}, flush: Effect.void } satisfies Trace2Monitor;
  }

  const traceFilePath = yield* fileSystem.makeTempFileScoped({
    prefix: `t3-coder-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const starts = new Map<string, { hookName: string; startedAtMs: number }>();
  const tail = yield* Ref.make<Trace2TailState>({ processedChars: 0, remainder: "" });

  const handleLine = Effect.fn("GitVcsDriver.handleTrace2Line")(function* (line: string) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      record = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const childKey = trace2ChildKey(record);
    if (childKey === null) return;
    const started = starts.get(childKey);
    if (record.child_class !== "hook" && started === undefined) return;
    const eventHookName = typeof record.hook_name === "string" ? record.hook_name.trim() : "";
    const hookName = eventHookName || started?.hookName || "";
    if (!hookName) return;

    if (record.event === "child_start") {
      starts.set(childKey, { hookName, startedAtMs: Date.now() });
      if (progress.onHookStarted) yield* progress.onHookStarted(hookName);
    } else if (record.event === "child_exit") {
      starts.delete(childKey);
      const rawCode = record.code ?? record.exitCode;
      const exitCode = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : null;
      const rawDuration = record.t_rel;
      const durationMs =
        typeof rawDuration === "number"
          ? Math.max(0, Math.round(rawDuration * 1_000))
          : started
            ? Math.max(0, Date.now() - started.startedAtMs)
            : null;
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const mutex = yield* Semaphore.make(1);
  const readDelta = mutex.withPermit(
    fileSystem.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Ref.modify(tail, (state) => {
          if (contents.length <= state.processedChars) return [[] as string[], state] as const;
          const lines = `${state.remainder}${contents.slice(state.processedChars)}`.split("\n");
          const remainder = lines.pop() ?? "";
          return [
            lines.map((item) => item.replace(/\r$/, "")),
            { processedChars: contents.length, remainder },
          ] as const;
        }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
      ),
      Effect.ignore,
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fileSystem.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    return eventPath === traceFilePath || path.basename(eventPath) === traceFileName
      ? readDelta
      : Effect.void;
  }).pipe(Effect.ignore, Effect.forkScoped);

  const flush = Effect.gen(function* () {
    yield* readDelta;
    const remainder = yield* Ref.modify(
      tail,
      (state) => [state.remainder.trim(), { ...state, remainder: "" }] as const,
    );
    if (remainder) yield* handleLine(remainder);
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => flush);
  return { env: { GIT_TRACE2_EVENT: traceFilePath }, flush } satisfies Trace2Monitor;
});

// Matches `git worktree remove` on a path git no longer tracks: "is not a
// working tree" when the registration is gone, "cannot remove working tree"
// when older Git versions fail validation on a registered-but-deleted directory.
function isMissingWorktreeStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  );
}

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}

function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted((left, right) => right.length - left.length);
}

function parseRemoteRef(
  ref: string,
  remoteNames: ReadonlyArray<string>,
): { remoteName: string; branchName: string } | null {
  for (const remoteName of remoteNames) {
    const prefix = `${remoteName}/`;
    if (!ref.startsWith(prefix)) continue;
    const branchName = ref.slice(prefix.length);
    return branchName.length > 0 ? { remoteName, branchName } : null;
  }
  return null;
}

// Ported from upstream GitVcsDriverCore.
function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (!match) continue;
    const [, name, url, direction] = match;
    if (!name || !url) continue;
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") remote.url = url;
    else remote.pushUrl = url;
    remotes.set(name, remote);
  }
  return remotes;
}

function parsePorcelainV2Paths(stdout: string): ReadonlyArray<string> {
  const pathAfterFields = (field: string, fieldCount: number): string | null => {
    let separatorIndex = -1;
    for (let count = 0; count < fieldCount; count += 1) {
      separatorIndex = field.indexOf(" ", separatorIndex + 1);
      if (separatorIndex < 0) return null;
    }
    const filePath = field.slice(separatorIndex + 1);
    return filePath || null;
  };
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.startsWith("? ") || field.startsWith("! ")) {
      const filePath = field.slice(2);
      if (filePath) paths.push(filePath);
      continue;
    }
    const filePath = field.startsWith("1 ")
      ? pathAfterFields(field, 8)
      : field.startsWith("2 ")
        ? pathAfterFields(field, 9)
        : field.startsWith("u ")
          ? pathAfterFields(field, 10)
          : null;
    if (filePath) paths.push(filePath);
    // Rename/copy records carry the original path as the next NUL field. The
    // working-tree UI should report the destination path only.
    if (field.startsWith("2 ")) index += 1;
  }
  return paths;
}

function parseNullSeparatedNumstat(
  stdout: string,
): ReadonlyArray<{ path: string; insertions: number; deletions: number }> {
  const fields = stdout.split("\0");
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (!field) continue;
    const firstTab = field.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : field.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = field.slice(0, firstTab);
    const deleted = field.slice(firstTab + 1, secondTab);
    let filePath = field.slice(secondTab + 1);
    if (!filePath) {
      // With `--numstat -z`, renames are encoded as a header followed by the
      // original and destination path. Keep the destination.
      index += 2;
      filePath = fields[index] ?? "";
    }
    if (!filePath) continue;
    entries.push({
      path: filePath,
      insertions: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      deletions: deleted === "-" ? 0 : Number.parseInt(deleted, 10) || 0,
    });
  }
  return entries;
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

const gitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    readonly appendTruncationMarker?: boolean;
    readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
    readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  },
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
    ...(options?.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}),
    ...(options?.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
      );
      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }
      const remotes = [...parseGitRemoteVerboseOutput(result.stdout)].flatMap(([name, remote]) =>
        remote.url
          ? [
              {
                name,
                url: remote.url,
                pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
                isPrimary: name === "origin",
              },
            ]
          : [],
      );
      return { remotes, freshness: yield* nowFreshness() };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.captureCheckpoint";
      const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
      const tempIndexPath = path.join(
        gitCommonDir,
        `t3-checkpoint-index-${NodeCrypto.randomUUID()}`,
      );
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "T3 Coder",
        GIT_AUTHOR_EMAIL: "t3-coder@localhost",
        GIT_COMMITTER_NAME: "T3 Coder",
        GIT_COMMITTER_EMAIL: "t3-coder@localhost",
      };

      const cleanupTempIndex = fileSystem
        .remove(tempIndexPath, { force: true })
        .pipe(Effect.ignore);

      yield* Effect.gen(function* () {
        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["read-tree", "HEAD"],
            env: commitEnv,
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `t3 checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }).pipe(Effect.ensuring(cleanupTempIndex));
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

const makeLocalGitService = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly appendTruncationMarker?: boolean;
      readonly progress?: ExecuteGitProgress;
    } = {},
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* createTrace2Monitor(fileSystem, path, options.progress);
        return yield* gitCommand(vcsProcess, operation, cwd, args, {
          ...options,
          ...(Object.keys(monitor.env).length > 0
            ? { env: { ...options.env, ...monitor.env } }
            : {}),
          ...(options.progress?.onStdoutLine
            ? { onStdoutLine: options.progress.onStdoutLine }
            : {}),
          ...(options.progress?.onStderrLine
            ? { onStderrLine: options.progress.onStderrLine }
            : {}),
        }).pipe(Effect.ensuring(monitor.flush));
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: `git ${args[0] ?? ""}`.trim(),
            cwd,
            detail: cause instanceof Error ? cause.message : "Git command failed.",
            cause,
          }),
      ),
    );

  const execute: GitVcsDriver["Service"]["execute"] = (input) =>
    run(input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
      ...(input.progress ? { progress: input.progress } : {}),
    });

  const currentBranch = (cwd: string) =>
    run("GitVcsDriver.currentBranch", cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)));

  const localBranchExists = (cwd: string, branch: string) =>
    run(
      "GitVcsDriver.localBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowNonZeroExit: true },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAutomaticBaseRef = Effect.fn("GitVcsDriver.resolveAutomaticBaseRef")(function* (
    cwd: string,
    branch: string,
  ) {
    const [configuredBaseResult, remotesResult] = yield* Effect.all([
      run(
        "GitVcsDriver.resolveAutomaticBaseRef.config",
        cwd,
        ["config", "--get", `branch.${branch}.gh-merge-base`],
        { allowNonZeroExit: true },
      ),
      run("GitVcsDriver.resolveAutomaticBaseRef.remotes", cwd, ["remote"], {
        allowNonZeroExit: true,
      }),
    ]);
    const remotes = remotesResult.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
    const primaryRemote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
    const remoteDefaultBranch = primaryRemote
      ? yield* run(
          "GitVcsDriver.resolveAutomaticBaseRef.remoteDefault",
          cwd,
          ["symbolic-ref", `refs/remotes/${primaryRemote}/HEAD`],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            const prefix = `refs/remotes/${primaryRemote}/`;
            const ref = result.stdout.trim();
            return result.exitCode === 0 && ref.startsWith(prefix)
              ? ref.slice(prefix.length)
              : null;
          }),
        )
      : null;
    const candidates = [
      configuredBaseResult.stdout.trim() || null,
      remoteDefaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const remotePrefix = primaryRemote ? `${primaryRemote}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === branch) continue;

      if (primaryRemote) {
        const remoteBranch = yield* run(
          "GitVcsDriver.resolveAutomaticBaseRef.remoteBranch",
          cwd,
          [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/remotes/${primaryRemote}/${normalizedCandidate}`,
          ],
          { allowNonZeroExit: true },
        );
        if (remoteBranch.exitCode === 0) return `${primaryRemote}/${normalizedCandidate}`;
      }
      if (yield* localBranchExists(cwd, normalizedCandidate)) return normalizedCandidate;
    }

    return null;
  });

  const statusDetailsLocal: GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "GitVcsDriver.statusDetailsLocal",
  )(function* (cwd) {
    const inside = yield* run(
      "GitVcsDriver.status.inside",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { allowNonZeroExit: true },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return {
        isRepo: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      };
    }

    const branch = yield* currentBranch(cwd);
    const [porcelain, numstat, remotesResult, hasMain, hasMaster] = yield* Effect.all([
      run("GitVcsDriver.status.porcelain", cwd, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ]),
      run("GitVcsDriver.status.numstat", cwd, ["diff", "--numstat", "-z", "HEAD", "--"], {
        allowNonZeroExit: true,
      }),
      run("GitVcsDriver.status.remotes", cwd, ["remote"], { allowNonZeroExit: true }),
      localBranchExists(cwd, "main"),
      localBranchExists(cwd, "master"),
    ]);

    const changedPaths = parsePorcelainV2Paths(porcelain.stdout);
    const stats = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of parseNullSeparatedNumstat(numstat.stdout)) {
      const existing = stats.get(entry.path) ?? { insertions: 0, deletions: 0 };
      stats.set(entry.path, {
        insertions: existing.insertions + entry.insertions,
        deletions: existing.deletions + entry.deletions,
      });
    }
    const remoteNames = remotesResult.exitCode === 0 ? parseRemoteNames(remotesResult.stdout) : [];
    const primaryRemote = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
    const remoteDefaultBranch = primaryRemote
      ? yield* run(
          "GitVcsDriver.status.remoteDefault",
          cwd,
          ["symbolic-ref", `refs/remotes/${primaryRemote}/HEAD`],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            const prefix = `refs/remotes/${primaryRemote}/`;
            const ref = result.stdout.trim();
            return result.exitCode === 0 && ref.startsWith(prefix)
              ? ref.slice(prefix.length)
              : null;
          }),
        )
      : null;
    const allPaths = [...new Set([...changedPaths, ...stats.keys()])].toSorted();
    const files = allPaths.map((filePath) => ({
      path: filePath,
      insertions: stats.get(filePath)?.insertions ?? 0,
      deletions: stats.get(filePath)?.deletions ?? 0,
    }));
    const defaultBranch = remoteDefaultBranch ?? (hasMain ? "main" : hasMaster ? "master" : branch);
    return {
      isRepo: true,
      isDefaultBranch: branch !== null && branch === defaultBranch,
      branch,
      hasWorkingTreeChanges: files.length > 0,
      workingTree: {
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
    };
  });

  const diffSource = Effect.fn("GitVcsDriver.diffSource")(function* (
    cwd: string,
    kind: "working-tree" | "branch-range",
    title: string,
    baseRef: string | null,
    headRef: string | null,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* run("GitVcsDriver.diff", cwd, args, {
      maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
      appendTruncationMarker: true,
    }).pipe(
      Effect.orElseSucceed(() => ({
        stdout: "",
        stdoutTruncated: false,
      })),
    );
    return {
      id: kind,
      kind,
      title,
      baseRef,
      headRef,
      diff: result.stdout,
      diffHash: NodeCrypto.createHash("sha256").update(result.stdout).digest("hex"),
      truncated: result.stdoutTruncated,
    } as const;
  });

  const readUntrackedReviewDiffs = Effect.fn("GitVcsDriver.readUntrackedReviewDiffs")(function* (
    cwd: string,
  ) {
    const untrackedResult = yield* run(
      "GitVcsDriver.readUntrackedReviewDiffs.list",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: REVIEW_UNTRACKED_PATHS_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    const untrackedPaths = splitNullSeparatedPaths(
      untrackedResult.stdout,
      untrackedResult.stdoutTruncated,
    );
    const diffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        run(
          "GitVcsDriver.readUntrackedReviewDiffs.diff",
          cwd,
          [
            "diff",
            "--no-index",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            ...PATCH_RENDER_PREFIX_ARGS,
            "--",
            "/dev/null",
            relativePath,
          ],
          {
            allowNonZeroExit: true,
            maxOutputBytes: REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      { concurrency: 4 },
    );
    return {
      diff: diffs
        .map((result) => result.stdout.trimEnd())
        .filter(Boolean)
        .join("\n"),
      truncated: untrackedResult.stdoutTruncated || diffs.some((result) => result.stdoutTruncated),
    };
  });

  const getReviewDiffPreview: GitVcsDriver["Service"]["getReviewDiffPreview"] = Effect.fn(
    "GitVcsDriver.getReviewDiffPreview",
  )(function* (input) {
    const details = yield* statusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources: [] };
    }
    const whitespace = input.ignoreWhitespace ? ["--ignore-all-space"] : [];
    const sources = [];
    if (input.sourceKind !== "branch-range") {
      const tracked = yield* diffSource(input.cwd, "working-tree", "Dirty worktree", "HEAD", null, [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--minimal",
        ...PATCH_RENDER_PREFIX_ARGS,
        ...whitespace,
        "HEAD",
        "--",
      ]);
      const untracked = yield* readUntrackedReviewDiffs(input.cwd).pipe(
        Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
      );
      const diff = [tracked.diff.trimEnd(), untracked.diff.trimEnd()].filter(Boolean).join("\n");
      sources.push({
        ...tracked,
        diff,
        diffHash: NodeCrypto.createHash("sha256").update(diff).digest("hex"),
        truncated: tracked.truncated || untracked.truncated,
      });
    }
    const automaticBranch =
      input.baseRef || input.sourceKind === "working-tree" ? null : details.branch;
    const baseRef =
      input.baseRef ??
      (automaticBranch ? yield* resolveAutomaticBaseRef(input.cwd, automaticBranch) : null);
    if (input.sourceKind !== "working-tree") {
      const headRef = details.branch ?? "HEAD";
      const branch = baseRef
        ? yield* diffSource(input.cwd, "branch-range", `Against ${baseRef}`, baseRef, headRef, [
            "diff",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--minimal",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...whitespace,
            `${baseRef}...HEAD`,
            "--",
          ])
        : {
            id: "branch-range" as const,
            kind: "branch-range" as const,
            title: "Against base branch",
            baseRef: null,
            headRef,
            diff: "",
            diffHash: NodeCrypto.createHash("sha256").update("").digest("hex"),
            truncated: false,
          };
      sources.push(branch);
    }
    return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources };
  });

  const readRevision = Effect.fn("GitVcsDriver.readRevision")(function* (
    cwd: string,
    revision: string,
    filePath: string,
  ) {
    const result = yield* run(
      "GitVcsDriver.readRevision",
      cwd,
      ["show", `${revision}:${filePath}`],
      {
        maxOutputBytes: MAX_REVIEW_DIFF_FILE_BYTES,
      },
    );
    if (result.stdoutTruncated) {
      return yield* new ReviewDiffFileTooLargeError({
        path: filePath,
        maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
      });
    }
    if (result.stdoutInvalidUtf8 || result.stdout.includes("\0")) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.readRevision",
        command: "git show",
        cwd,
        detail: `Cannot expand binary file '${filePath}'.`,
      });
    }
    return result.stdout;
  });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const readWorkspaceFile = (
    cwd: string,
    repositoryRoot: string,
    filePath: string,
  ): Effect.Effect<string, ReviewDiffFileError> => {
    const candidate = path.resolve(repositoryRoot, filePath);
    if (!isPathWithinRoot(repositoryRoot, candidate)) {
      return Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.readWorkspaceFile",
          command: "read workspace file",
          cwd,
          detail: "Diff path escapes the workspace.",
        }),
      );
    }
    return Effect.gen(function* () {
      const [realRepositoryRoot, realCandidate] = yield* Effect.all([
        fileSystem.realPath(repositoryRoot),
        fileSystem.realPath(candidate),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.readWorkspaceFile.realPath",
              command: "fs.realPath",
              cwd,
              detail: `Could not resolve diff file '${filePath}'.`,
              cause,
            }),
        ),
      );
      if (!isPathWithinRoot(realRepositoryRoot, realCandidate)) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.readWorkspaceFile.realPath",
          command: "fs.realPath",
          cwd,
          detail: "Diff path escapes the workspace.",
        });
      }
      const stat = yield* fileSystem.stat(realCandidate).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.readWorkspaceFile.stat",
              command: "fs.stat",
              cwd,
              detail: `Could not inspect diff file '${filePath}'.`,
              cause,
            }),
        ),
      );
      if (stat.type !== "File" || stat.size > MAX_REVIEW_DIFF_FILE_BYTES) {
        if (stat.type !== "File") {
          return yield* new GitCommandError({
            operation: "GitVcsDriver.readWorkspaceFile",
            command: "read workspace file",
            cwd,
            detail: "Diff path is not a regular file.",
          });
        }
        return yield* new ReviewDiffFileTooLargeError({
          path: filePath,
          maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
        });
      }
      const bytes = yield* fileSystem.readFile(realCandidate).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.readWorkspaceFile.readFile",
              command: "fs.readFile",
              cwd,
              detail: `Could not read diff file '${filePath}'.`,
              cause,
            }),
        ),
      );
      if (bytes.includes(0)) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.readWorkspaceFile.readFile",
          command: "fs.readFile",
          cwd,
          detail: `Cannot expand binary file '${filePath}'.`,
        });
      }
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.readWorkspaceFile.readFile",
            command: "fs.readFile",
            cwd,
            detail: `Cannot expand binary file '${filePath}'.`,
            cause,
          }),
      });
    });
  };

  const getReviewDiffFileContents: GitVcsDriver["Service"]["getReviewDiffFileContents"] = Effect.fn(
    "GitVcsDriver.getReviewDiffFileContents",
  )(function* (input) {
    if (input.sourceKind === "working-tree") {
      const repositoryRoot = yield* run(
        "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
        input.cwd,
        ["rev-parse", "--show-toplevel"],
      ).pipe(Effect.map((result) => result.stdout.trim()));
      if (repositoryRoot.length === 0) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
          command: "git rev-parse",
          cwd: input.cwd,
          detail: "Could not resolve the Git repository root.",
        });
      }
      return {
        oldContents:
          input.changeType === "new"
            ? ""
            : yield* readRevision(input.cwd, input.baseRef ?? "HEAD", input.oldPath),
        newContents:
          input.changeType === "deleted"
            ? ""
            : yield* readWorkspaceFile(input.cwd, repositoryRoot, input.newPath),
      };
    }
    if (!input.baseRef || !input.headRef) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.getReviewDiffFileContents",
        command: "git merge-base",
        cwd: input.cwd,
        detail: "Branch diff file expansion requires both base and head refs.",
      });
    }
    const mergeBase = yield* run("GitVcsDriver.getReviewDiffFileContents.mergeBase", input.cwd, [
      "merge-base",
      input.baseRef,
      input.headRef,
    ]).pipe(Effect.map((result) => result.stdout.trim()));
    if (mergeBase.length === 0) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.getReviewDiffFileContents.mergeBase",
        command: "git merge-base",
        cwd: input.cwd,
        detail: "Could not resolve the branch comparison base.",
      });
    }
    return {
      oldContents:
        input.changeType === "new" ? "" : yield* readRevision(input.cwd, mergeBase, input.oldPath),
      newContents:
        input.changeType === "deleted"
          ? ""
          : yield* readRevision(input.cwd, input.headRef, input.newPath),
    };
  });

  const listRefs: GitVcsDriver["Service"]["listRefs"] = Effect.fn("GitVcsDriver.listRefs")(
    function* (input) {
      const inside = yield* run(
        "GitVcsDriver.listRefs.inside",
        input.cwd,
        ["rev-parse", "--is-inside-work-tree"],
        { allowNonZeroExit: true },
      );
      if (inside.exitCode !== 0) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }
      const [branches, worktrees, activeBranch, defaultRef, remotesResult] = yield* Effect.all([
        run("GitVcsDriver.listRefs.branches", input.cwd, [
          "for-each-ref",
          "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
          "refs/heads",
          "refs/remotes",
        ]),
        run("GitVcsDriver.listRefs.worktrees", input.cwd, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
        currentBranch(input.cwd),
        run(
          "GitVcsDriver.listRefs.defaultRef",
          input.cwd,
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ),
        run("GitVcsDriver.listRefs.remotes", input.cwd, ["remote"], {
          allowNonZeroExit: true,
        }),
      ]);
      const parsedWorktrees = [...parseWorktreeBranchPaths(worktrees.stdout)].map(
        ([branch, worktreePath]) => [branch, path.normalize(path.resolve(worktreePath))] as const,
      );
      const existingWorktrees = yield* Effect.filter(
        parsedWorktrees,
        ([, worktreePath]) =>
          fileSystem.stat(worktreePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        { concurrency: 16 },
      );
      const worktreeByBranch = new Map(existingWorktrees);
      const remoteNames =
        remotesResult.exitCode === 0 ? parseRemoteNames(remotesResult.stdout) : [];
      const defaultBranch =
        defaultRef.exitCode === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;
      const query = input.query?.toLocaleLowerCase() ?? "";
      const refsWithDates: Array<{ timestamp: number; ref: VcsRef }> = [];
      for (const line of branches.stdout.split("\n")) {
        if (line.length === 0) continue;
        const [fullName = "", timestamp = "0", symbolicTarget = ""] = line.split("\t");
        if (symbolicTarget) continue;
        if (fullName.startsWith("refs/heads/")) {
          const name = fullName.slice("refs/heads/".length);
          refsWithDates.push({
            timestamp: Number.parseInt(timestamp, 10) || 0,
            ref: {
              name,
              current: name === activeBranch,
              isRemote: false,
              isDefault: name === defaultBranch,
              worktreePath: worktreeByBranch.get(name) ?? null,
            },
          });
          continue;
        }
        if (!fullName.startsWith("refs/remotes/")) continue;
        const name = fullName.slice("refs/remotes/".length);
        const remoteRef = parseRemoteRef(name, remoteNames);
        refsWithDates.push({
          timestamp: Number.parseInt(timestamp, 10) || 0,
          ref: {
            name,
            current: false,
            isRemote: true,
            isDefault:
              defaultBranch !== null &&
              remoteRef?.remoteName === "origin" &&
              remoteRef.branchName === defaultBranch,
            worktreePath: null,
            ...(remoteRef ? { remoteName: remoteRef.remoteName } : {}),
          },
        });
      }
      const sortedRefsWithDates = refsWithDates.toSorted(
        (left, right) =>
          right.timestamp - left.timestamp || left.ref.name.localeCompare(right.ref.name),
      );
      const allRefs = input.includeMatchingRemoteRefs
        ? sortedRefsWithDates.map(({ ref }) => ref)
        : dedupeRemoteBranchesWithLocalMatches(sortedRefsWithDates.map(({ ref }) => ref));
      const prioritizedRefs = allRefs.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const refsForKind =
        input.refKind === "local"
          ? prioritizedRefs.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? prioritizedRefs.filter((ref) => ref.isRemote)
            : prioritizedRefs;
      const matchingRefs = refsForKind.filter(
        (ref) => query.length === 0 || ref.name.toLocaleLowerCase().includes(query),
      );
      const offset = input.cursor ?? 0;
      const limit = input.limit ?? 100;
      const refs = matchingRefs.slice(offset, offset + limit);
      const nextOffset = offset + refs.length;
      return {
        refs,
        isRepo: true,
        hasPrimaryRemote: remoteNames.includes("origin"),
        nextCursor: nextOffset < matchingRefs.length ? nextOffset : null,
        totalCount: matchingRefs.length,
      };
    },
  );

  const refStatusLocal: GitVcsDriver["Service"]["refStatusLocal"] = Effect.fn(
    "GitVcsDriver.refStatusLocal",
  )(function* (cwd) {
    const inside = yield* run(
      "GitVcsDriver.refStatus.inside",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { allowNonZeroExit: true },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return { isRepo: false, refName: null };
    }
    return { isRepo: true, refName: yield* currentBranch(cwd) };
  });

  const createWorktree: GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "GitVcsDriver.createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const targetPath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    const args = ["worktree", "add"];
    if (input.newRefName) args.push("-b", input.newRefName);
    args.push(targetPath, input.refName);
    yield* run("GitVcsDriver.createWorktree", input.cwd, args, { timeoutMs: 300_000 });
    const hasSubmodules = yield* fileSystem
      .exists(path.join(targetPath, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasSubmodules) {
      // Populate already-cached or local submodules without allowing Git to
      // open a non-loopback connection outside the Coder CLI boundary.
      yield* run("GitVcsDriver.createWorktree.updateSubmodules", targetPath, [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
        "--no-fetch",
      ]).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Worktree submodule checkout failed; the worktree was created with empty submodule paths.",
          ),
        ),
      );
    }
    if (input.newRefName && input.baseRefName) {
      const remotes = yield* run("GitVcsDriver.createWorktree.remotes", input.cwd, ["remote"], {
        allowNonZeroExit: true,
      });
      const parsedBaseRef = parseRemoteRef(input.baseRefName, parseRemoteNames(remotes.stdout));
      yield* run("GitVcsDriver.createWorktree.configureBaseRef", input.cwd, [
        "config",
        `branch.${input.newRefName}.gh-merge-base`,
        parsedBaseRef?.branchName ?? input.baseRefName,
      ]);
    }
    return { worktree: { path: targetPath, refName: input.newRefName ?? input.refName } };
  });

  const pruneWorktrees: GitVcsDriver["Service"]["pruneWorktrees"] = (input) =>
    run("GitVcsDriver.pruneWorktrees", input.cwd, ["worktree", "prune"], {
      timeoutMs: 15_000,
    }).pipe(Effect.asVoid);

  const removeWorktree: GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "GitVcsDriver.removeWorktree",
  )(function* (input) {
    const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path];
    const result = yield* run("GitVcsDriver.removeWorktree", input.cwd, args, {
      // Dependency-heavy worktrees can take minutes to remove. Keep the
      // operation bounded without interrupting git midway through cleanup.
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      allowNonZeroExit: true,
    });
    if (result.exitCode === 0) {
      return;
    }
    // Threads can share a worktree path, and worktrees get removed or pruned
    // outside the app, so an already-gone worktree is a no-op. Prune any stale
    // registration so a later `worktree add` can reuse the path.
    const alreadyGone =
      isMissingWorktreeStderr(result.stderr) &&
      !(yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => false)));
    if (alreadyGone) {
      yield* pruneWorktrees({ cwd: input.cwd });
      return;
    }
    // Raw stderr stays out of both the wire error and logs because it can carry
    // secrets; retain only bounded diagnostics for genuine failures.
    yield* Effect.logWarning(
      `GitVcsDriver.removeWorktree: git worktree remove exited with code ${result.exitCode} for ${input.path} (stderr length ${result.stderr.length}).`,
    );
    return yield* new GitCommandError({
      operation: "GitVcsDriver.removeWorktree",
      command: "git worktree",
      cwd: input.cwd,
      argumentCount: args.length,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      detail: "git worktree remove failed",
    });
  });

  const switchRef: GitVcsDriver["Service"]["switchRef"] = Effect.fn("GitVcsDriver.switchRef")(
    function* (input) {
      // Ported from upstream GitVcsDriverCore.switchRef: the picked ref may be
      // a local branch or a remote-tracking branch such as "origin/feature",
      // which git cannot check out directly. Resolve the checkout target the
      // same way upstream does: prefer the local branch of the same name, then
      // a local branch that already tracks the remote ref, then a fresh
      // tracking branch created from the remote ref.
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          localBranchExists(input.cwd, input.refName),
          run(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            { allowNonZeroExit: true },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* run(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* localBranchExists(input.cwd, localTrackedBranchCandidate)
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* run("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 300_000,
      });
      return { refName: yield* currentBranch(input.cwd) };
    },
  );

  const ensureRemote: GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "GitVcsDriver.ensureRemote",
  )(function* (input) {
    const remotes = yield* run("GitVcsDriver.ensureRemote.list", input.cwd, ["remote"]);
    const names = new Set(parseRemoteNames(remotes.stdout));
    let candidate = input.preferredName;
    let suffix = 2;
    while (names.has(candidate)) {
      const existing = yield* run(
        "GitVcsDriver.ensureRemote.getUrl",
        input.cwd,
        ["remote", "get-url", candidate],
        { allowNonZeroExit: true },
      );
      if (existing.exitCode === 0 && existing.stdout.trim() === input.url) {
        return candidate;
      }
      candidate = `${input.preferredName}-${suffix}`;
      suffix += 1;
    }
    yield* run("GitVcsDriver.ensureRemote.add", input.cwd, ["remote", "add", candidate, input.url]);
    return candidate;
  });

  const pushCurrentBranch: GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "GitVcsDriver.pushCurrentBranch",
  )(function* (cwd, requestedBranch, options) {
    const branch = requestedBranch ?? (yield* currentBranch(cwd));
    if (branch === null) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.pushCurrentBranch",
        command: "git push",
        cwd,
        detail: "A checked-out branch is required before pushing.",
      });
    }
    const upstream = yield* run(
      "GitVcsDriver.pushCurrentBranch.upstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { allowNonZeroExit: true },
    );
    const upstreamBranch = upstream.exitCode === 0 ? upstream.stdout.trim() || null : null;
    const remoteName = options?.remoteName ?? "origin";
    const targetUpstream = `${remoteName}/${branch}`;
    const setUpstream =
      upstreamBranch === null ||
      (options?.remoteName !== undefined && upstreamBranch !== targetUpstream);
    const pushArgs = setUpstream
      ? ["push", "--set-upstream", remoteName, branch]
      : options?.remoteName !== undefined
        ? ["push", remoteName, branch]
        : ["push"];
    yield* run("GitVcsDriver.pushCurrentBranch.push", cwd, pushArgs, {
      timeoutMs: 300_000,
      ...(options?.progress ? { progress: options.progress } : {}),
    });
    return {
      branch,
      upstreamBranch: setUpstream ? targetUpstream : upstreamBranch,
      setUpstream,
    };
  });

  return GitVcsDriver.of({
    execute,
    statusDetailsLocal,
    statusDetails: statusDetailsLocal,
    ensureRemote,
    pushCurrentBranch,
    refStatusLocal,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    listRefs,
    createWorktree,
    removeWorktree,
    pruneWorktrees,
    renameBranch: (input) =>
      input.oldBranch === input.newBranch
        ? Effect.succeed({ branch: input.newBranch })
        : run("GitVcsDriver.renameBranch", input.cwd, [
            "branch",
            "-m",
            "--",
            input.oldBranch,
            input.newBranch,
          ]).pipe(Effect.as({ branch: input.newBranch })),
    moveWorktree: (input) =>
      input.oldPath === input.newPath
        ? Effect.void
        : run(
            "GitVcsDriver.moveWorktree",
            input.cwd,
            ["worktree", "move", input.oldPath, input.newPath],
            { timeoutMs: 300_000 },
          ).pipe(Effect.asVoid),
    createRef: Effect.fn("GitVcsDriver.createRef")(function* (input) {
      yield* run("GitVcsDriver.createRef", input.cwd, ["branch", input.refName]);
      if (input.switchRef) yield* switchRef(input);
      return { refName: input.refName };
    }),
    switchRef,
    initRepo: (input) => run("GitVcsDriver.initRepo", input.cwd, ["init"]).pipe(Effect.asVoid),
  });
});

export const make = Effect.gen(function* () {
  const git = yield* makeLocalGitService;
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
