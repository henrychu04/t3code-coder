// Coder: the helper's fork-only RPC methods, served beside upstream's handlers in `ws.ts`.
import { CODER_RPC_FRAME_MAX_BYTES } from "@t3tools/coder-cli/rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import {
  type CommandId,
  type CoderWsRpcGroup,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationThreadTranscriptTooLargeError,
  ThreadId,
  VcsRenameThreadBranchError,
  WS_METHODS,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";

import { makeServeAsset } from "./coderAssets.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as ServerConfig from "./config.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { renameBranchWithCompensation } from "./git/renameBranchWithCompensation.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./orchestration-v2/WireProjection.ts";
import { readProjectConfig } from "./project/configMetadata.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProcessRunner from "./processRunner.ts";
import { readCoderWorkspaceResourceUsage } from "./coderWorkspaceStats.ts";

/** The methods only the helper serves; `ws.ts` builds every other `CoderWsRpcGroup` method. */
export const CODER_WS_METHODS = [
  WS_METHODS.orchestrationGetThreadBoundedSnapshot,
  WS_METHODS.orchestrationGetThreadHistoryPage,
  WS_METHODS.orchestrationGetThreadTranscript,
  WS_METHODS.pullRequestsDiff,
  WS_METHODS.projectsGetConfig,
  WS_METHODS.coderServeAsset,
  WS_METHODS.coderWriteRequestBody,
  WS_METHODS.coderWorkspaceResourceUsage,
  WS_METHODS.subscribeVcsRefStatus,
  WS_METHODS.vcsRenameThreadBranch,
  WS_METHODS.reviewOpenDiffFileContents,
  WS_METHODS.reviewReadDiffFileChunk,
] as const;

// Leaves room for the RPC envelope around the value inside one helper stdio frame.
const HELPER_STDIO_FRAME_LIMIT_BYTES = CODER_RPC_FRAME_MAX_BYTES - 64 * 1024;

/** Fail a snapshot that cannot fit one helper stdio frame before transport encoding. */
export function exceedsHelperStdioFrame(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") > HELPER_STDIO_FRAME_LIMIT_BYTES;
}

type CoderWsHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof CoderWsRpcGroup>>;

interface UpstreamHelpers {
  readonly serverCommandId: (tag: string) => Effect.Effect<CommandId>;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
}

/** The fork-only handlers. `ws.ts` spreads these after its own handlers. */
export const makeHandlers = ({ serverCommandId, refreshGitStatus }: UpstreamHelpers) =>
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const review = yield* ReviewService.ReviewService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const terminalManager = yield* TerminalManager.TerminalManager;
    const config = yield* ServerConfig.ServerConfig;
    const assets = yield* makeServeAsset;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const { descriptor } = yield* CoderEnvironment.CoderEnvironment;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // Coder: upstream's HTTP bounded thread snapshot, served over helper stdio.
    const loadThreadSnapshotWindow = (threadId: ThreadId, deferWork: boolean) =>
      threadManagement
        .getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          deferWork,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        })
        .pipe(
          Effect.map((snapshot) => ({
            ...snapshot,
            projection: projectThreadProjectionForWire(snapshot.projection),
          })),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId,
                message: `Failed to load orchestration V2 thread ${threadId}`,
                cause,
              }),
          ),
        );

    const getThreadBoundedSnapshot = Effect.fn("ws.orchestrationV2.getThreadBoundedSnapshot")(
      function* (threadId: ThreadId, deferWork: boolean) {
        const snapshot = yield* loadThreadSnapshotWindow(threadId, deferWork);
        const bounded = buildBoundedThreadProjection({
          projection: snapshot.projection,
          snapshotSequence: snapshot.snapshotSequence,
        });
        const result = {
          snapshotSequence: snapshot.snapshotSequence,
          projection: bounded.projection,
          historyCursor: bounded.historyCursor,
          hasMoreHistory: bounded.hasMoreHistory,
          latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
        };
        if (exceedsHelperStdioFrame(result)) {
          return yield* new OrchestrationV2GetThreadProjectionError({
            threadId,
            message: "The thread snapshot exceeds the helper stdio frame limit.",
          });
        }
        return result;
      },
    );

    // Coder: upstream's HTTP thread transcript route, served over helper stdio.
    const getThreadTranscript = Effect.fn("ws.orchestrationV2.getThreadTranscript")(function* (
      threadId: ThreadId,
    ) {
      const transcript = yield* threadManagement.getThreadTranscript(threadId).pipe(
        Effect.provideService(CoderEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
        }),
        Effect.catchTag("ThreadTranscriptTooLargeError", () =>
          Effect.fail(new OrchestrationThreadTranscriptTooLargeError({ threadId })),
        ),
        Effect.mapError((cause) =>
          cause._tag === "OrchestrationThreadTranscriptTooLargeError"
            ? cause
            : new OrchestrationV2GetThreadProjectionError({
                threadId,
                message: `Failed to load orchestration V2 thread ${threadId} transcript`,
                cause,
              }),
        ),
      );
      if (exceedsHelperStdioFrame(transcript)) {
        return yield* new OrchestrationThreadTranscriptTooLargeError({ threadId });
      }
      return transcript;
    });

    // Coder: upstream's HTTP older-history page, served over helper stdio.
    const getThreadHistoryPage = Effect.fn("ws.orchestrationV2.getThreadHistoryPage")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly cursor: string;
        readonly throughEntryId?: string | undefined;
        readonly view?: "conversation" | "activity" | "work" | undefined;
        readonly deferWork?: boolean;
      }) {
        const failure = (cause: unknown) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to load orchestration V2 thread ${input.threadId} history`,
            cause,
          });
        yield* Effect.try({
          try: () => decodeThreadHistoryCursor(input.cursor),
          catch: (cause) =>
            cause instanceof InvalidThreadHistoryCursorError
              ? new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: "The thread history cursor is invalid.",
                })
              : failure(cause),
        });
        const page = yield* threadManagement
          .getThreadHistoryPage(
            input.threadId,
            input.cursor,
            input.throughEntryId,
            input.view === "conversation",
            input.view === "work" ? "work" : input.deferWork === true ? "deferred" : undefined,
          )
          .pipe(Effect.mapError(failure));
        if (exceedsHelperStdioFrame(page)) {
          return yield* new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: "The thread history page exceeds the helper stdio frame limit.",
          });
        }
        return page;
      },
    );

    // Coder: rename the managed workspace branch and worktree together through workspace Git.
    const renameThreadBranchError = (detail: string, cause?: unknown) =>
      new VcsRenameThreadBranchError({
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    // Coder: rename the managed workspace branch and worktree together through workspace Git.
    const nextManagedWorktreePathForBranch = Effect.fn("nextManagedWorktreePathForBranch")(
      function* (branch: string, currentPath?: string) {
        const worktreesRoot = path.resolve(config.worktreesDir);
        const resolvedCurrentPath = currentPath ? path.resolve(currentPath) : undefined;
        const currentParent = resolvedCurrentPath
          ? path.dirname(resolvedCurrentPath)
          : worktreesRoot;
        if (
          resolvedCurrentPath &&
          currentParent !== worktreesRoot &&
          path.dirname(currentParent) !== worktreesRoot
        ) {
          return yield* Effect.fail(
            renameThreadBranchError(
              "Only worktree folders managed by T3 Code can be renamed from the UI.",
            ),
          );
        }

        const baseName = sanitizeBranchFragment(branch).replaceAll("/", "-");
        for (let suffix = 1; suffix <= 1_000; suffix += 1) {
          const name = suffix === 1 ? baseName : `${baseName}-${suffix}`;
          const candidate = path.join(currentParent, name);
          if (candidate === resolvedCurrentPath || !(yield* fileSystem.exists(candidate))) {
            return candidate;
          }
        }
        return yield* Effect.fail(
          renameThreadBranchError("Could not find an available folder name for this worktree."),
        );
      },
    );

    // Coder: rename the managed workspace branch and worktree together through workspace Git.
    const nextManagedWorktreePath = (currentPath: string, branch: string) =>
      nextManagedWorktreePathForBranch(branch, currentPath);

    // Coder: rename the managed workspace branch and worktree together through workspace Git.
    const renameThreadBranch = Effect.fn("renameThreadBranch")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly expectedBranch: string;
      readonly newBranch: string;
      readonly renameWorktreeFolder: boolean;
    }) {
      const thread = yield* threadManagement.getThreadShell(input.threadId).pipe(
        Effect.map((shell) => shell ?? undefined),
        Effect.mapError((cause) => renameThreadBranchError("Could not load the thread.", cause)),
      );
      if (!thread) {
        return yield* Effect.fail(renameThreadBranchError("The thread no longer exists."));
      }
      if (thread.branch !== input.expectedBranch) {
        return yield* Effect.fail(
          renameThreadBranchError(
            `The thread branch changed from ${input.expectedBranch} to ${thread.branch ?? "an unknown branch"}. Refresh and try again.`,
          ),
        );
      }

      const project = yield* projectService.getShell(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => renameThreadBranchError("Could not load the project.", cause)),
      );
      if (!project) {
        return yield* Effect.fail(renameThreadBranchError("The project no longer exists."));
      }

      const currentCwd = thread.worktreePath ?? project.workspaceRoot;
      if (path.resolve(input.cwd) !== path.resolve(currentCwd)) {
        return yield* Effect.fail(
          renameThreadBranchError("The thread workspace changed. Refresh and try again."),
        );
      }
      const localStatus = yield* gitWorkflow
        .localStatus({ cwd: currentCwd })
        .pipe(
          Effect.mapError((cause) =>
            renameThreadBranchError("Could not read the checked-out branch.", cause),
          ),
        );
      if (localStatus.refName !== input.expectedBranch) {
        return yield* Effect.fail(
          renameThreadBranchError(
            `The checkout is on ${localStatus.refName ?? "a detached HEAD"}, not ${input.expectedBranch}. Refresh and try again.`,
          ),
        );
      }

      let nextWorktreePath = thread.worktreePath;
      if (input.renameWorktreeFolder) {
        if (!thread.worktreePath) {
          return yield* Effect.fail(
            renameThreadBranchError("This thread does not have a dedicated worktree folder."),
          );
        }
        const shell = yield* threadManagement
          .getShellSnapshot({ location: "active" })
          .pipe(
            Effect.mapError((cause) =>
              renameThreadBranchError("Could not inspect worktree ownership.", cause),
            ),
          );
        if (
          shell.threads.some(
            (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
          )
        ) {
          return yield* Effect.fail(
            renameThreadBranchError(
              "This worktree is shared by another thread, so its folder cannot be renamed here.",
            ),
          );
        }
        nextWorktreePath = yield* nextManagedWorktreePath(thread.worktreePath, input.newBranch);
      }

      if (input.renameWorktreeFolder) {
        // Coder: upstream detaches provider sessions when the worktree path changes, but the
        // folder moves first here, so an active run must finish before its cwd moves.
        if (thread.activeRunId !== null) {
          return yield* Effect.fail(
            renameThreadBranchError("Stop the running turn before renaming the worktree folder."),
          );
        }
        yield* terminalManager
          .close({ threadId: thread.id })
          .pipe(
            Effect.mapError((cause) =>
              renameThreadBranchError("Could not close the thread terminals.", cause),
            ),
          );
      }

      let worktreeMoved = false;
      const mutate = renameBranchWithCompensation({
        rename: gitWorkflow.renameBranch({
          cwd: currentCwd,
          oldBranch: input.expectedBranch,
          newBranch: input.newBranch,
        }),
        afterRename: () =>
          Effect.gen(function* () {
            if (
              input.renameWorktreeFolder &&
              thread.worktreePath &&
              nextWorktreePath &&
              thread.worktreePath !== nextWorktreePath
            ) {
              yield* gitWorkflow.moveWorktree({
                cwd: project.workspaceRoot,
                oldPath: thread.worktreePath,
                newPath: nextWorktreePath,
              });
              worktreeMoved = true;
            }

            yield* orchestrationEngine.dispatch({
              type: "thread.metadata.update",
              commandId: yield* serverCommandId("thread-branch-rename"),
              threadId: thread.id,
              branch: input.newBranch,
              worktreePath: nextWorktreePath,
              expectedWorktreePath: thread.worktreePath,
            });
          }),
        rollback: () =>
          Effect.gen(function* () {
            if (worktreeMoved && thread.worktreePath && nextWorktreePath) {
              yield* gitWorkflow
                .moveWorktree({
                  cwd: project.workspaceRoot,
                  oldPath: nextWorktreePath,
                  newPath: thread.worktreePath,
                })
                .pipe(Effect.ignore);
            }
            yield* gitWorkflow
              .renameBranch({
                cwd: project.workspaceRoot,
                oldBranch: input.newBranch,
                newBranch: input.expectedBranch,
              })
              .pipe(Effect.ignore);
          }),
      });

      yield* mutate.pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            renameThreadBranchError(
              "Could not rename the branch and worktree.",
              Cause.squash(cause),
            ),
          ),
        ),
      );

      const refreshCwd = nextWorktreePath ?? project.workspaceRoot;
      yield* Effect.all([refreshGitStatus(refreshCwd), refreshGitStatus(project.workspaceRoot)], {
        concurrency: "unbounded",
      }).pipe(Effect.ignore);
      return { branch: input.newBranch, worktreePath: nextWorktreePath };
    });
    return {
      // Coder: upstream's HTTP bounded snapshot and history routes over helper stdio.
      [WS_METHODS.orchestrationGetThreadBoundedSnapshot]: (input) =>
        getThreadBoundedSnapshot(input.threadId, input.deferWork === true),
      [WS_METHODS.orchestrationGetThreadHistoryPage]: (input) => getThreadHistoryPage(input),
      [WS_METHODS.orchestrationGetThreadTranscript]: (input) => getThreadTranscript(input.threadId),
      // Coder: serve GitLab diffs over stdio instead of environment HTTP.
      [WS_METHODS.pullRequestsDiff]: (input) => pullRequests.diff(input),
      // Coder: read fixed bounded project metadata in the workspace.
      [WS_METHODS.projectsGetConfig]: ({ projectId }) =>
        Effect.gen(function* () {
          const project = yield* projectService.getShell(projectId);
          if (Option.isNone(project)) return { status: "unavailable" as const, file: null };
          return readProjectConfig(project.value.workspaceRoot);
        }).pipe(Effect.orElseSucceed(() => ({ status: "unavailable" as const, file: null }))),
      // Coder: the gateway's loopback asset and upload routes, answered by upstream's routes in
      // process; an upload's body arrives in chunks.
      [WS_METHODS.coderServeAsset]: (input) => assets.serve(input),
      [WS_METHODS.coderWriteRequestBody]: (input) => assets.writeRequestBody(input),
      [WS_METHODS.coderWorkspaceResourceUsage]: () =>
        readCoderWorkspaceResourceUsage.pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      // Coder: subscribe to non-mutating local branch status.
      [WS_METHODS.subscribeVcsRefStatus]: ({ cwd }) => vcsStatusBroadcaster.streamRefStatus(cwd),
      // Coder: rename the branch and managed worktree together.
      [WS_METHODS.vcsRenameThreadBranch]: (input) =>
        renameThreadBranch(input).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              cause instanceof VcsRenameThreadBranchError
                ? cause
                : renameThreadBranchError("Could not rename the branch and worktree.", cause),
            ),
          ),
        ),
      // Coder: expand oversized review files through bounded stdio chunks.
      [WS_METHODS.reviewOpenDiffFileContents]: (input) => review.openDiffFileContents(input),
      // Coder: read bounded chunks with a revision check.
      [WS_METHODS.reviewReadDiffFileChunk]: (input) => review.readDiffFileChunk(input),
    } satisfies Partial<CoderWsHandlers>;
  });
