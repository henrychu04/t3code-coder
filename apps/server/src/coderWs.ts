// Coder: the helper's fork-only RPC methods, served beside upstream's handlers in `ws.ts`.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import {
  type CommandId,
  type CoderWsRpcGroup,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectId,
  ProjectImageReadError,
  ProjectListEntriesError,
  type ProjectListEntriesInput,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  ProjectTextSearchError,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
  ThreadId,
  VcsRenameThreadBranchError,
  WorkspaceListDirectoriesError,
  WS_METHODS,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";

import * as ServerConfig from "./config.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { renameBranchWithCompensation } from "./git/renameBranchWithCompensation.ts";
import * as LegacyScreenshotArtifacts from "./orchestration-v2/legacy/LegacyScreenshotArtifacts.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import type * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import type * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  OLDER_THREAD_USER_TURN_LIMIT,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./orchestration-v2/WireProjection.ts";
import { isCoderPullRequestLink } from "./coderPullRequestLink.ts";
import { readProjectConfig } from "./project/configMetadata.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import { readProjectImage } from "./workspace/ProjectImages.ts";
import * as ScreenshotArtifacts from "./workspace/ScreenshotArtifacts.ts";
import { readTurnItemAssetChunk } from "./workspace/TurnItemAssets.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

/** The methods only the helper serves; `ws.ts` builds every other `CoderWsRpcGroup` method. */
export const CODER_WS_METHODS = [
  WS_METHODS.orchestrationGetThreadBoundedSnapshot,
  WS_METHODS.orchestrationGetThreadHistoryPage,
  WS_METHODS.sourceControlProbeWriteAccess,
  WS_METHODS.pullRequestsDiff,
  WS_METHODS.projectsGetConfig,
  WS_METHODS.projectsSearchText,
  WS_METHODS.projectsReadImage,
  WS_METHODS.projectsCreateFile,
  WS_METHODS.workspaceListDirectories,
  WS_METHODS.workspaceReadScreenshotArtifact,
  WS_METHODS.workspaceReadTurnItemAsset,
  WS_METHODS.workspaceReadAttachmentFile,
  WS_METHODS.workspaceListLegacyScreenshotArtifacts,
  WS_METHODS.subscribeVcsRefStatus,
  WS_METHODS.vcsRenameThreadBranch,
  WS_METHODS.reviewOpenDiffFileContents,
  WS_METHODS.reviewReadDiffFileChunk,
] as const;

// Helper stdio frames are limited to 8 MiB, including RPC overhead.
const HELPER_STDIO_FRAME_LIMIT_BYTES = 8 * 1024 * 1024 - 64 * 1024;

/** Fail a snapshot that cannot fit one helper stdio frame before transport encoding. */
export function exceedsHelperStdioFrame(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") > HELPER_STDIO_FRAME_LIMIT_BYTES;
}

/** Thread merge-request links must belong to a known GitLab host. */
export const makeEnsureCoderPullRequestLink = (
  projectStore: ProjectStore.ProjectStoreV2["Service"],
) =>
  Effect.fn("ws.ensureCoderPullRequestLink")(function* (
    command: Parameters<(typeof ThreadMessageIntake)["dispatchCommand"]>[0],
  ) {
    if (command.type !== "thread.pull-request.link") return;
    const projects = yield* projectStore.listShells();
    if (
      isCoderPullRequestLink(command, projects) &&
      ["manual", "created", "agent"].includes(command.source)
    ) {
      return;
    }
    return yield* new OrchestrationV2DispatchCommandError({
      commandId: command.commandId,
      commandType: command.type,
      message: "The merge request must belong to a known GitLab host.",
    });
  });

type CoderWsHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof CoderWsRpcGroup>>;

/** Upstream's Files handlers from `ws.ts`, which run once the requesting thread owns the root. */
interface UpstreamFilesHandlers {
  readonly [WS_METHODS.projectsListEntries]: (
    input: ProjectListEntriesInput,
  ) => Effect.Effect<ProjectListEntriesResult, ProjectListEntriesError>;
  readonly [WS_METHODS.projectsReadFile]: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<ProjectReadFileResult, ProjectReadFileError>;
  readonly [WS_METHODS.projectsWriteFile]: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<ProjectWriteFileResult, ProjectWriteFileError>;
}

interface UpstreamHelpers {
  readonly serverCommandId: (tag: string) => Effect.Effect<CommandId>;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly projectFileFailureContext: (
    error:
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError,
  ) => {
    readonly failure: ProjectFileFailure;
    readonly resolvedPath?: string;
    readonly resolvedWorkspaceRoot?: string;
    readonly operation?: ProjectFileOperation;
    readonly operationPath?: string;
  };
}

/**
 * The fork-only handlers, plus upstream's Files listing, read, and write behind the requesting
 * thread's root verification. `ws.ts` spreads these after its own handlers.
 */
export const makeHandlers = (
  upstream: UpstreamFilesHandlers,
  { serverCommandId, refreshGitStatus, projectFileFailureContext }: UpstreamHelpers,
) =>
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const review = yield* ReviewService.ReviewService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const terminalManager = yield* TerminalManager.TerminalManager;
    const config = yield* ServerConfig.ServerConfig;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    // Legacy images are read in bounded chunks over helper stdio.
    const screenshotArtifacts = yield* ScreenshotArtifacts.ScreenshotArtifacts;
    const legacyScreenshotArtifacts = yield* LegacyScreenshotArtifacts.LegacyScreenshotArtifacts;
    // Source-control mutations use the workspace glab login and write-policy probe.
    const gitLabCli = yield* GitLabCli.GitLabCli;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    // Coder: upstream's HTTP bounded thread snapshot, served over helper stdio.
    const loadThreadSnapshotWindow = (
      threadId: ThreadId,
      anchor?: { readonly itemId: string; readonly threadId: ThreadId },
    ) =>
      threadManagement
        .getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit:
            anchor === undefined
              ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
              : OLDER_THREAD_USER_TURN_LIMIT,
          ...(anchor === undefined
            ? {}
            : { anchorItemId: anchor.itemId as never, anchorThreadId: anchor.threadId }),
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
      function* (threadId: ThreadId) {
        const snapshot = yield* loadThreadSnapshotWindow(threadId);
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
          payloadBudgetExceeded: bounded.payloadBudgetExceeded,
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

    // Coder: upstream's HTTP older-history page, served over helper stdio.
    const getThreadHistoryPage = Effect.fn("ws.orchestrationV2.getThreadHistoryPage")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly cursor: string;
        readonly throughEntryId?: string | undefined;
        readonly view?: "conversation" | "activity" | undefined;
      }) {
        // Coder: a find-in-thread page (a target entry or the conversation view) uses upstream's
        // history read; plain paging keeps the bounded snapshot-window page below.
        if (input.throughEntryId !== undefined || input.view !== undefined) {
          const upstreamPage = yield* threadManagement
            .getThreadHistoryPage(
              input.threadId,
              input.cursor,
              input.throughEntryId,
              input.view === "conversation",
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to load orchestration V2 thread ${input.threadId} history`,
                    cause,
                  }),
              ),
            );
          if (exceedsHelperStdioFrame(upstreamPage)) {
            return yield* new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: "The thread history page exceeds the helper stdio frame limit.",
            });
          }
          return upstreamPage;
        }
        const invalidCursor = () =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: "The thread history cursor is invalid.",
          });
        const decoded = yield* Effect.try({
          try: () => decodeThreadHistoryCursor(input.cursor),
          catch: (cause) =>
            cause instanceof InvalidThreadHistoryCursorError
              ? invalidCursor()
              : new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to load orchestration V2 thread ${input.threadId} history`,
                  cause,
                }),
        });
        const snapshot = yield* loadThreadSnapshotWindow(input.threadId, {
          itemId: decoded.si,
          threadId: ThreadId.make(decoded.st),
        });
        const page = yield* Effect.try({
          try: () =>
            selectHistoryPageFromCursor({
              items: snapshot.projection.visibleTurnItems,
              cursor: input.cursor,
              snapshotSequence: snapshot.snapshotSequence,
            }),
          catch: (cause) =>
            cause instanceof InvalidThreadHistoryCursorError
              ? invalidCursor()
              : new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to load orchestration V2 thread ${input.threadId} history`,
                  cause,
                }),
        });
        const result = {
          snapshotSequence: snapshot.snapshotSequence,
          items: page.items,
          nextCursor: page.nextCursor,
          hasMoreHistory: page.hasMoreHistory,
        };
        if (exceedsHelperStdioFrame(result)) {
          return yield* new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: "The thread history page exceeds the helper stdio frame limit.",
          });
        }
        return result;
      },
    );

    // Coder: rename the managed workspace branch and worktree together through workspace Git.
    const renameThreadBranchError = (detail: string, cause?: unknown) =>
      new VcsRenameThreadBranchError({
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    // Coder: verify file and media roots belong to the requesting thread.
    const workspaceOwnedByThread = Effect.fn("ws.workspaceOwnedByThread")(function* (input: {
      readonly threadId?: ThreadId | undefined;
      readonly draftProjectId?: ProjectId | undefined;
      readonly cwd: string;
    }) {
      const cwd = path.resolve(input.cwd);
      if (input.threadId === undefined) {
        // Coder: a draft has no persisted thread, so it names its project. Its root may be the
        // project's workspace root or a worktree one of the project's persisted threads owns.
        if (input.draftProjectId === undefined) return false;
        const project = yield* projectService.getShell(input.draftProjectId);
        if (Option.isNone(project)) return false;
        if (cwd === path.resolve(project.value.workspaceRoot)) return true;
        const threads = yield* threadManagement.listProjectThreads({
          projectId: input.draftProjectId,
          includeSubagents: true,
        });
        return threads.some(
          (thread) => thread.worktreePath !== null && cwd === path.resolve(thread.worktreePath),
        );
      }
      const thread = yield* threadManagement.getThreadShell(input.threadId);
      if (thread === null) return false;
      const project = yield* projectService.getShell(thread.projectId);
      if (Option.isNone(project)) return false;
      const ownedRoot = thread.worktreePath ?? project.value.workspaceRoot;
      return cwd === path.resolve(ownedRoot);
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
        getThreadBoundedSnapshot(input.threadId),
      [WS_METHODS.orchestrationGetThreadHistoryPage]: (input) => getThreadHistoryPage(input),
      // Coder: probe GitLab workspace write policy through glab.
      [WS_METHODS.sourceControlProbeWriteAccess]: (input) =>
        gitLabCli.reprobeWriteAccess({ cwd: config.cwd }),
      // Coder: serve GitLab diffs over stdio instead of environment HTTP.
      [WS_METHODS.pullRequestsDiff]: (input) => pullRequests.diff(input),
      // Coder: read fixed bounded project metadata in the workspace.
      [WS_METHODS.projectsGetConfig]: ({ projectId }) =>
        Effect.gen(function* () {
          const project = yield* projectService.getShell(projectId);
          if (Option.isNone(project)) return { status: "unavailable" as const, file: null };
          return readProjectConfig(project.value.workspaceRoot);
        }).pipe(Effect.orElseSucceed(() => ({ status: "unavailable" as const, file: null }))),
      // Coder: search bounded project contents after thread ownership validation.
      [WS_METHODS.projectsSearchText]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned) {
            return yield* new ProjectTextSearchError({
              queryLength: input.query.length,
              limit: input.limit,
              failure: "workspace_not_owned_by_thread",
            });
          }
          return yield* workspaceEntries.searchText(input).pipe(
            Effect.mapError(
              () =>
                new ProjectTextSearchError({
                  queryLength: input.query.length,
                  limit: input.limit,
                  failure: "search_index_search_failed",
                }),
            ),
          );
        }),
      // Coder: read signature-validated media in bounded helper chunks.
      [WS_METHODS.projectsReadImage]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned) return yield* new ProjectImageReadError({ message: "Media is unavailable." });
          return yield* readProjectImage(input);
        }),
      // Coder: a new file for upstream's "Save to workspace", in the owner's verified project.
      [WS_METHODS.projectsCreateFile]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned)
            return yield* new ProjectWriteFileError({
              ...input,
              failure: "workspace_not_owned_by_thread",
            });
          return yield* workspaceFileSystem.createFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          );
        }),
      [WS_METHODS.workspaceListDirectories]: (input) =>
        workspaceEntries.listDirectories(input).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceListDirectoriesError({
                path: input.path ?? "workspace home",
                message: cause.message,
                cause,
              }),
          ),
        ),
      // Coder: read preserved legacy artifacts through bounded stdio chunks.
      [WS_METHODS.workspaceReadScreenshotArtifact]: (input) => screenshotArtifacts.readChunk(input),
      // Coder: MCP App documents and tool output images, in place of upstream's signed asset URLs.
      [WS_METHODS.workspaceReadTurnItemAsset]: (input) =>
        readTurnItemAssetChunk(input, {
          attachmentsDir: config.attachmentsDir,
          getTurnItem: orchestrationEngine.getTurnItem,
        }),
      // Coder: a sent file attachment, in place of upstream's signed attachment asset URL.
      [WS_METHODS.workspaceReadAttachmentFile]: (input) =>
        screenshotArtifacts.readAttachmentFileChunk(input),
      [WS_METHODS.workspaceListLegacyScreenshotArtifacts]: (input) =>
        legacyScreenshotArtifacts.listAfterMessage(input.messageId),
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
      // Files access must verify the root belongs to the requesting thread.
      [WS_METHODS.projectsListEntries]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned)
            return yield* new ProjectListEntriesError({
              ...input,
              failure: "workspace_not_owned_by_thread",
            });
          return yield* upstream[WS_METHODS.projectsListEntries](input);
        }),
      [WS_METHODS.projectsReadFile]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned)
            return yield* new ProjectReadFileError({
              ...input,
              failure: "workspace_not_owned_by_thread",
            });
          return yield* upstream[WS_METHODS.projectsReadFile](input);
        }),
      [WS_METHODS.projectsWriteFile]: (input) =>
        Effect.gen(function* () {
          const owned = yield* workspaceOwnedByThread(input).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!owned)
            return yield* new ProjectWriteFileError({
              ...input,
              failure: "workspace_not_owned_by_thread",
            });
          return yield* upstream[WS_METHODS.projectsWriteFile](input);
        }),
    } satisfies Partial<CoderWsHandlers>;
  });
