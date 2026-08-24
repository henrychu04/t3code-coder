import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
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
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as ServerConfig from "../config.ts";

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

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
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
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

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
    readonly appendTruncationMarker?: boolean;
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
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
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
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
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
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    } = {},
  ) =>
    gitCommand(vcsProcess, operation, cwd, args, options).pipe(
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
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
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
    const [porcelain, numstat, hasMain, hasMaster] = yield* Effect.all([
      run("GitVcsDriver.status.porcelain", cwd, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      run("GitVcsDriver.status.numstat", cwd, ["diff", "--numstat", "HEAD"], {
        allowNonZeroExit: true,
      }),
      localBranchExists(cwd, "main"),
      localBranchExists(cwd, "master"),
    ]);

    const changedPaths = porcelain.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter(Boolean);
    const stats = new Map<string, { insertions: number; deletions: number }>();
    for (const line of numstat.stdout.split("\n")) {
      const [added, deleted, filePath] = line.split("\t");
      if (!filePath) continue;
      stats.set(filePath, {
        insertions: added === "-" ? 0 : Number.parseInt(added ?? "0", 10) || 0,
        deletions: deleted === "-" ? 0 : Number.parseInt(deleted ?? "0", 10) || 0,
      });
    }
    const allPaths = [...new Set([...changedPaths, ...stats.keys()])].toSorted();
    const files = allPaths.map((filePath) => ({
      path: filePath,
      insertions: stats.get(filePath)?.insertions ?? 0,
      deletions: stats.get(filePath)?.deletions ?? 0,
    }));
    const defaultBranch = hasMain ? "main" : hasMaster ? "master" : branch;
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
    args: ReadonlyArray<string>,
  ) {
    const result = yield* run("GitVcsDriver.diff", cwd, args, {
      allowNonZeroExit: true,
      maxOutputBytes: 120_000,
    });
    if (result.exitCode !== 0 || result.stdout.length === 0) return null;
    return {
      id: kind,
      kind,
      title,
      baseRef,
      headRef: kind === "branch-range" ? "HEAD" : null,
      diff: result.stdout,
      diffHash: NodeCrypto.createHash("sha256").update(result.stdout).digest("hex"),
      truncated: result.stdoutTruncated,
    } as const;
  });

  const getReviewDiffPreview: GitVcsDriver["Service"]["getReviewDiffPreview"] = Effect.fn(
    "GitVcsDriver.getReviewDiffPreview",
  )(function* (input) {
    const whitespace = input.ignoreWhitespace ? ["--ignore-all-space"] : [];
    const sources = [];
    const working = yield* diffSource(input.cwd, "working-tree", "Working tree", "HEAD", [
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      ...whitespace,
      "HEAD",
    ]);
    if (working) sources.push(working);
    if (input.baseRef) {
      const branch = yield* diffSource(
        input.cwd,
        "branch-range",
        `Changes from ${input.baseRef}`,
        input.baseRef,
        [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          ...whitespace,
          `${input.baseRef}...HEAD`,
        ],
      );
      if (branch) sources.push(branch);
    }
    return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources };
  });

  const readRevision = (cwd: string, revision: string, filePath: string) =>
    run("GitVcsDriver.readRevision", cwd, ["show", `${revision}:${filePath}`], {
      allowNonZeroExit: true,
      maxOutputBytes: 1024 * 1024,
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")));

  const readWorkspaceFile = (cwd: string, filePath: string) => {
    const candidate = path.resolve(cwd, filePath);
    const relative = path.relative(cwd, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.readWorkspaceFile",
          command: "read workspace file",
          cwd,
          detail: "Diff path escapes the workspace.",
        }),
      );
    }
    return fileSystem
      .readFileString(candidate)
      .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed("") }));
  };

  const getReviewDiffFileContents: GitVcsDriver["Service"]["getReviewDiffFileContents"] = Effect.fn(
    "GitVcsDriver.getReviewDiffFileContents",
  )(function* (input) {
    if (input.sourceKind === "working-tree") {
      return {
        oldContents:
          input.changeType === "new" ? "" : yield* readRevision(input.cwd, "HEAD", input.oldPath),
        newContents:
          input.changeType === "deleted" ? "" : yield* readWorkspaceFile(input.cwd, input.newPath),
      };
    }
    const baseRef = input.baseRef ?? "HEAD";
    const headRef = input.headRef ?? "HEAD";
    return {
      oldContents:
        input.changeType === "new" ? "" : yield* readRevision(input.cwd, baseRef, input.oldPath),
      newContents:
        input.changeType === "deleted"
          ? ""
          : yield* readRevision(input.cwd, headRef, input.newPath),
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
      const [branches, worktrees, activeBranch, hasMain, hasMaster] = yield* Effect.all([
        run("GitVcsDriver.listRefs.branches", input.cwd, [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
        ]),
        run("GitVcsDriver.listRefs.worktrees", input.cwd, ["worktree", "list", "--porcelain"]),
        currentBranch(input.cwd),
        localBranchExists(input.cwd, "main"),
        localBranchExists(input.cwd, "master"),
      ]);
      const worktreeByBranch = new Map<string, string>();
      let worktreePath: string | null = null;
      for (const line of worktrees.stdout.split("\n")) {
        if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
        if (line.startsWith("branch refs/heads/") && worktreePath) {
          worktreeByBranch.set(line.slice("branch refs/heads/".length), worktreePath);
        }
        if (line.length === 0) worktreePath = null;
      }
      const defaultBranch = hasMain ? "main" : hasMaster ? "master" : activeBranch;
      const query = input.query?.toLocaleLowerCase() ?? "";
      const refsWithDates = branches.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", timestamp = "0"] = line.split("\t");
          return {
            timestamp: Number.parseInt(timestamp, 10) || 0,
            ref: {
              name,
              current: name === activeBranch,
              isDefault: name === defaultBranch,
              worktreePath: worktreeByBranch.get(name) ?? null,
            } satisfies VcsRef,
          };
        })
        .filter(({ ref }) => query.length === 0 || ref.name.toLocaleLowerCase().includes(query))
        .toSorted(
          (left, right) =>
            right.timestamp - left.timestamp || left.ref.name.localeCompare(right.ref.name),
        );
      const offset = input.cursor ?? 0;
      const limit = input.limit ?? 100;
      const refs = refsWithDates.slice(offset, offset + limit).map(({ ref }) => ref);
      const nextOffset = offset + refs.length;
      return {
        refs,
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: nextOffset < refsWithDates.length ? nextOffset : null,
        totalCount: refsWithDates.length,
      };
    },
  );

  const createWorktree: GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "GitVcsDriver.createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const targetPath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    const args = ["worktree", "add"];
    if (input.newRefName) args.push("-b", input.newRefName);
    args.push(targetPath, input.baseRefName ?? input.refName);
    yield* run("GitVcsDriver.createWorktree", input.cwd, args, { timeoutMs: 300_000 });
    return { worktree: { path: targetPath, refName: input.newRefName ?? input.refName } };
  });

  const removeWorktree: GitVcsDriver["Service"]["removeWorktree"] = (input) =>
    run(
      "GitVcsDriver.removeWorktree",
      input.cwd,
      ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path],
      { timeoutMs: 300_000 },
    ).pipe(Effect.asVoid);

  const switchRef: GitVcsDriver["Service"]["switchRef"] = Effect.fn("GitVcsDriver.switchRef")(
    function* (input) {
      yield* run("GitVcsDriver.switchRef", input.cwd, ["switch", input.refName], {
        timeoutMs: 300_000,
      });
      return { refName: yield* currentBranch(input.cwd) };
    },
  );

  return GitVcsDriver.of({
    execute,
    statusDetailsLocal,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    listRefs,
    createWorktree,
    removeWorktree,
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
