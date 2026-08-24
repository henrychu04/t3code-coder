import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  CoderWsRpcGroup,
  CommandId,
  GitCommandError,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadShell,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationSearchThreadsError,
  ORCHESTRATION_WS_METHODS,
  type ProjectEntriesFailure,
  ProjectSearchEntriesError,
  ProjectId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  ThreadId,
  VcsRenameThreadBranchError,
  WorkspaceListDirectoriesError,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  buildGeneratedWorktreeBranchName,
  isTemporaryWorktreeBranch,
  sanitizeBranchFragment,
} from "@t3tools/shared/git";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderRuntimeStartup from "./coderRuntimeStartup.ts";
import * as CoderVcsStatus from "./coderVcsStatus.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { TextGeneration } from "./textGeneration/TextGeneration.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as ScreenshotArtifacts from "./workspace/ScreenshotArtifacts.ts";

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const RESUME_MAX_GAP = 1_000;

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return { failure: "workspace_root_not_found", normalizedCwd: error.normalizedWorkspaceRoot };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
  }
}

function isThreadDetailEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

interface ShellProjectionQueries {
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, unknown>;
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, unknown>;
}

export function projectShellEvent(
  event: OrchestrationEvent,
  projections: ShellProjectionQueries,
): Effect.Effect<OrchestrationShellStreamEvent, OrchestrationGetSnapshotError> {
  const sequence = event.sequence;
  if (event.type === "project.deleted") {
    return Effect.succeed({
      kind: "project-removed" as const,
      sequence,
      projectId: event.payload.projectId,
    });
  }
  if (event.type === "thread.deleted" || event.type === "thread.archived") {
    return Effect.succeed({
      kind: "thread-removed" as const,
      sequence,
      threadId: event.payload.threadId,
    });
  }
  if (event.aggregateKind === "project") {
    const projectId = ProjectId.make(event.aggregateId);
    return projections.getProjectShellById(projectId).pipe(
      Effect.map(
        Option.match({
          onNone: () => ({ kind: "project-removed" as const, sequence, projectId }),
          onSome: (project) => ({ kind: "project-upserted" as const, sequence, project }),
        }),
      ),
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: `Failed to project project ${projectId}`,
            cause,
          }),
      ),
    );
  }
  const threadId = ThreadId.make(event.aggregateId);
  return projections.getThreadShellById(threadId).pipe(
    Effect.map(
      Option.match({
        onNone: () => ({ kind: "thread-removed" as const, sequence, threadId }),
        onSome: (thread) => ({ kind: "thread-upserted" as const, sequence, thread }),
      }),
    ),
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to project thread ${threadId}`,
          cause,
        }),
    ),
  );
}

export function compensateFailedBootstrap(input: {
  readonly worktree?: { readonly cwd: string; readonly path: string };
  readonly removeWorktree: (worktree: {
    readonly cwd: string;
    readonly path: string;
    readonly force: true;
  }) => Effect.Effect<unknown, unknown>;
  readonly deleteThread?: Effect.Effect<unknown, unknown>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (input.worktree) {
      yield* input.removeWorktree({ ...input.worktree, force: true }).pipe(Effect.ignore);
    }
    if (input.deleteThread) yield* input.deleteThread.pipe(Effect.ignore);
  });
}

export const layer = CoderWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* CoderEnvironment.CoderEnvironment;
    const startup = yield* CoderRuntimeStartup.CoderRuntimeStartup;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providerService = yield* ProviderService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const screenshotArtifacts = yield* ScreenshotArtifacts.ScreenshotArtifacts;
    const vcsStatus = yield* CoderVcsStatus.CoderVcsStatus;
    const git = yield* GitWorkflowService.GitWorkflowService;
    const provisioning = yield* VcsProvisioningService.VcsProvisioningService;
    const review = yield* ReviewService.ReviewService;
    const terminals = yield* TerminalManager.TerminalManager;

    const toDispatchError = (cause: unknown, message: string) =>
      isDispatchError(cause) ? cause : new OrchestrationDispatchCommandError({ message, cause });
    const randomUuid = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => toDispatchError(cause, "Failed to create a command identifier.")),
    );
    const commandId = (tag: string) =>
      randomUuid.pipe(Effect.map((uuid) => CommandId.make(`coder:${tag}:${uuid}`)));
    const gitCommandError = (operation: string, cwd: string, cause: unknown) =>
      new GitCommandError({
        operation,
        command: "git",
        cwd,
        detail: cause instanceof Error ? cause.message : `Git ${operation} failed.`,
        cause,
      });
    const renameThreadBranchError = (detail: string, cause?: unknown) =>
      new VcsRenameThreadBranchError({
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

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

    const nextManagedWorktreePath = (currentPath: string, branch: string) =>
      nextManagedWorktreePathForBranch(branch, currentPath);

    const renameThreadBranch = Effect.fn("renameThreadBranch")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly expectedBranch: string;
      readonly newBranch: string;
      readonly renameWorktreeFolder: boolean;
    }) {
      const thread = yield* projections.getThreadShellById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
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

      const project = yield* projections.getProjectShellById(thread.projectId).pipe(
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
      const localStatus = yield* git
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
        const shell = yield* projections
          .getShellSnapshot()
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
        if (thread.session && thread.session.status !== "stopped") {
          yield* providerService
            .stopSession({ threadId: thread.id })
            .pipe(
              Effect.mapError((cause) =>
                renameThreadBranchError("Could not stop the agent session.", cause),
              ),
            );
          yield* orchestration
            .dispatch({
              type: "thread.session.set",
              commandId: yield* commandId("worktree-rename-session-stop"),
              threadId: thread.id,
              session: {
                ...thread.session,
                status: "stopped",
                activeTurnId: null,
                updatedAt: yield* nowIso,
              },
              createdAt: yield* nowIso,
            })
            .pipe(
              Effect.mapError((cause) =>
                renameThreadBranchError("Could not update the stopped agent session.", cause),
              ),
            );
        }
        yield* terminals
          .close({ threadId: thread.id })
          .pipe(
            Effect.mapError((cause) =>
              renameThreadBranchError("Could not close the thread terminals.", cause),
            ),
          );
      }

      let branchRenamed = false;
      let worktreeMoved = false;
      const mutate = Effect.gen(function* () {
        yield* git.renameBranch({
          cwd: currentCwd,
          oldBranch: input.expectedBranch,
          newBranch: input.newBranch,
        });
        branchRenamed = input.expectedBranch !== input.newBranch;

        if (
          input.renameWorktreeFolder &&
          thread.worktreePath &&
          nextWorktreePath &&
          thread.worktreePath !== nextWorktreePath
        ) {
          yield* git.moveWorktree({
            cwd: project.workspaceRoot,
            oldPath: thread.worktreePath,
            newPath: nextWorktreePath,
          });
          worktreeMoved = true;
        }

        yield* orchestration.dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("thread-branch-rename"),
          threadId: thread.id,
          branch: input.newBranch,
          expectedBranch: input.expectedBranch,
          worktreePath: nextWorktreePath,
        });
      });

      yield* mutate.pipe(
        Effect.catchCause((cause) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (worktreeMoved && thread.worktreePath && nextWorktreePath) {
                yield* git
                  .moveWorktree({
                    cwd: project.workspaceRoot,
                    oldPath: nextWorktreePath,
                    newPath: thread.worktreePath,
                  })
                  .pipe(Effect.ignore);
              }
              if (branchRenamed) {
                yield* git
                  .renameBranch({
                    cwd: project.workspaceRoot,
                    oldBranch: input.newBranch,
                    newBranch: input.expectedBranch,
                  })
                  .pipe(Effect.ignore);
              }
              return yield* Effect.fail(
                renameThreadBranchError(
                  "Could not rename the branch and worktree.",
                  Cause.squash(cause),
                ),
              );
            }),
          ),
        ),
      );

      const refreshCwd = nextWorktreePath ?? project.workspaceRoot;
      yield* Effect.all([vcsStatus.refresh(refreshCwd), vcsStatus.refresh(project.workspaceRoot)], {
        concurrency: "unbounded",
      }).pipe(Effect.ignore);
      return { branch: input.newBranch, worktreePath: nextWorktreePath };
    });

    const dispatchBootstrap = (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ) =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...turnStart } = command;
        let createdThread = false;
        let createdWorktree: { readonly cwd: string; readonly path: string } | undefined;
        const cleanup = () =>
          compensateFailedBootstrap({
            ...(createdWorktree ? { worktree: createdWorktree } : {}),
            removeWorktree: git.removeWorktree,
            ...(createdThread
              ? {
                  deleteThread: commandId("bootstrap-cleanup").pipe(
                    Effect.flatMap((nextCommandId) =>
                      orchestration.dispatch({
                        type: "thread.delete",
                        commandId: nextCommandId,
                        threadId: command.threadId,
                      }),
                    ),
                  ),
                }
              : {}),
          });
        const program = Effect.gen(function* () {
          if (bootstrap?.createThread) {
            yield* orchestration.dispatch({
              type: "thread.create",
              commandId: yield* commandId("thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            });
            createdThread = true;
          }
          if (bootstrap?.prepareWorktree) {
            const prepareWorktree = bootstrap.prepareWorktree;
            const temporaryBranch = prepareWorktree.branch;
            const generatedBranch = temporaryBranch
              ? yield* Effect.gen(function* () {
                  if (!isTemporaryWorktreeBranch(temporaryBranch)) {
                    return undefined;
                  }
                  const serverSettings = yield* settings.getSettings;
                  const generated = yield* textGeneration.generateBranchName({
                    cwd: prepareWorktree.projectCwd,
                    message: turnStart.message.text,
                    modelSelection: serverSettings.textGenerationModelSelection,
                  });
                  const baseBranch = buildGeneratedWorktreeBranchName(generated.branch);
                  const matchingRefs = yield* git.listRefs({
                    cwd: prepareWorktree.projectCwd,
                    query: baseBranch,
                    refKind: "local",
                    limit: 200,
                  });
                  const existingBranches = new Set(matchingRefs.refs.map((ref) => ref.name));
                  const repoWorktreesDir = path.join(
                    config.worktreesDir,
                    path.basename(prepareWorktree.projectCwd),
                  );
                  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
                    const branch = suffix === 1 ? baseBranch : `${baseBranch}-${suffix}`;
                    const worktreePath = path.join(repoWorktreesDir, branch.replaceAll("/", "-"));
                    if (
                      !existingBranches.has(branch) &&
                      !(yield* fileSystem.exists(worktreePath))
                    ) {
                      return branch;
                    }
                  }
                  return yield* Effect.fail(
                    new Error(`Could not find an available worktree name for '${baseBranch}'.`),
                  );
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to generate initial branch and worktree name", {
                      threadId: command.threadId,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(undefined)),
                  ),
                )
              : undefined;
            const worktree = yield* git.createWorktree({
              cwd: prepareWorktree.projectCwd,
              refName: prepareWorktree.baseBranch,
              newRefName: generatedBranch ?? temporaryBranch,
              baseRefName: prepareWorktree.baseBranch,
              path: null,
            });
            createdWorktree = {
              cwd: prepareWorktree.projectCwd,
              path: worktree.worktree.path,
            };
            yield* orchestration.dispatch({
              type: "thread.meta.update",
              commandId: yield* commandId("thread-worktree"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: worktree.worktree.path,
            });
            yield* vcsStatus.refresh(worktree.worktree.path).pipe(Effect.ignore);
          }
          return yield* orchestration.dispatch(turnStart);
        });
        return yield* program.pipe(
          Effect.catchCause((cause) =>
            Effect.uninterruptible(cleanup()).pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.fail(
                  toDispatchError(Cause.squash(cause), "Failed to start the Claude turn."),
                ),
              ),
            ),
          ),
        );
      });

    const dispatch = (command: OrchestrationCommand) =>
      startup.enqueueCommand(
        command.type === "thread.turn.start" && command.bootstrap
          ? dispatchBootstrap(command)
          : orchestration
              .dispatch(command)
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchError(cause, "Failed to dispatch the orchestration command."),
                ),
              ),
      );

    const loadServerConfig = Effect.gen(function* () {
      const providerSnapshots = yield* providers.getProviders;
      const serverSettings = ServerSettings.redactServerSettingsForClient(
        yield* settings.getSettings,
      );
      return {
        environment: environment.descriptor,
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        issues: [],
        providers: providerSnapshots,
        settings: serverSettings,
        shellResumeCompletionMarker: true,
        threadResumeCompletionMarker: true,
        threadSnapshotPagination: true,
      };
    });

    return CoderWsRpcGroup.of({
      [WS_METHODS.serverProbe]: () => Effect.succeed({}),
      [WS_METHODS.serverGetConfig]: () => loadServerConfig,
      [WS_METHODS.serverGetSettings]: () =>
        settings.getSettings.pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
      [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
        settings
          .updateSettings(patch)
          .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                cwd: input.cwd,
                queryLength: input.query.length,
                limit: input.limit,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
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
      [WS_METHODS.workspaceReadScreenshotArtifact]: (input) => screenshotArtifacts.readChunk(input),
      [WS_METHODS.providerListSlashCommands]: ({ instanceId, cwd }) =>
        providerInstances.getInstance(instanceId).pipe(
          Effect.flatMap((instance) => {
            if (instance?.listSlashCommands) {
              return instance.listSlashCommands(cwd);
            }
            return instance
              ? instance.snapshot.getSnapshot.pipe(Effect.map((snapshot) => snapshot.slashCommands))
              : Effect.succeed([]);
          }),
        ),
      [WS_METHODS.subscribeVcsStatus]: ({ cwd }) => vcsStatus.stream(cwd),
      [WS_METHODS.vcsRefreshStatus]: ({ cwd }) => vcsStatus.refresh(cwd),
      [WS_METHODS.vcsListRefs]: (input) => git.listRefs(input),
      [WS_METHODS.vcsCreateWorktree]: (input) =>
        git.createWorktree(input).pipe(
          Effect.mapError((cause) => gitCommandError("create-worktree", input.cwd, cause)),
          Effect.tap(() => vcsStatus.refresh(input.cwd).pipe(Effect.ignore)),
        ),
      [WS_METHODS.vcsRemoveWorktree]: (input) =>
        git.removeWorktree(input).pipe(
          Effect.mapError((cause) => gitCommandError("remove-worktree", input.cwd, cause)),
          Effect.tap(() => vcsStatus.refresh(input.cwd).pipe(Effect.ignore)),
        ),
      [WS_METHODS.vcsCreateRef]: (input) =>
        git.createRef(input).pipe(
          Effect.mapError((cause) => gitCommandError("create-ref", input.cwd, cause)),
          Effect.tap(() => vcsStatus.refresh(input.cwd).pipe(Effect.ignore)),
        ),
      [WS_METHODS.vcsSwitchRef]: (input) =>
        git.switchRef(input).pipe(
          Effect.mapError((cause) => gitCommandError("switch-ref", input.cwd, cause)),
          Effect.tap(() => vcsStatus.refresh(input.cwd).pipe(Effect.ignore)),
        ),
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
      [WS_METHODS.vcsInit]: (input) =>
        provisioning.initRepository(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Failed to initialize the Git repository.", { cause }).pipe(
              Effect.andThen(Effect.die(Cause.squash(cause))),
            ),
          ),
          Effect.tap(() => vcsStatus.refresh(input.cwd).pipe(Effect.ignore)),
        ),
      [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
      [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
      [WS_METHODS.terminalOpen]: (input) => terminals.open(input),
      [WS_METHODS.terminalAttach]: (input) =>
        Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
          Effect.acquireRelease(
            terminals.attachStream(input, (event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [WS_METHODS.terminalWrite]: (input) => terminals.write(input),
      [WS_METHODS.terminalResize]: (input) => terminals.resize(input),
      [WS_METHODS.terminalClear]: (input) => terminals.clear(input),
      [WS_METHODS.terminalRestart]: (input) => terminals.restart(input),
      [WS_METHODS.terminalClose]: (input) => terminals.close(input),
      [WS_METHODS.subscribeTerminalEvents]: () =>
        Stream.callback<TerminalEvent>((queue) =>
          Effect.acquireRelease(
            terminals.subscribe((event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [WS_METHODS.subscribeTerminalMetadata]: () =>
        Stream.callback<TerminalMetadataStreamEvent>((queue) =>
          Effect.acquireRelease(
            terminals.subscribeMetadata((event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* providers.refresh().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
            const providerChanges = providers.streamChanges.pipe(
              Stream.map((nextProviders) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers: nextProviders },
              })),
              Stream.debounce(Duration.millis(200)),
            );
            const settingChanges = settings.streamChanges.pipe(
              Stream.map(ServerSettings.redactServerSettingsForClient),
              Stream.map((nextSettings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings: nextSettings },
              })),
            );
            return Stream.concat(
              Stream.make({
                version: 1 as const,
                type: "snapshot" as const,
                config: yield* loadServerConfig,
              }),
              Stream.merge(providerChanges, settingChanges),
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const project = yield* projections
              .getActiveProjectByWorkspaceRoot(config.cwd)
              .pipe(Effect.orDie);
            const bootstrapProjectId = Option.isSome(project) ? project.value.id : undefined;
            const thread = bootstrapProjectId
              ? yield* projections
                  .getFirstActiveThreadIdByProjectId(bootstrapProjectId)
                  .pipe(Effect.orDie)
              : Option.none<ThreadId>();
            return Stream.make(
              {
                version: 1 as const,
                sequence: 1,
                type: "welcome" as const,
                payload: {
                  environment: environment.descriptor,
                  cwd: config.cwd,
                  projectName: config.cwd.split("/").filter(Boolean).at(-1) ?? "workspace",
                  ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
                  ...(Option.isSome(thread) ? { bootstrapThreadId: thread.value } : {}),
                },
              },
              {
                version: 1 as const,
                sequence: 2,
                type: "ready" as const,
                payload: { at: yield* nowIso, environment: environment.descriptor },
              },
            );
          }),
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        normalizeDispatchCommand(command).pipe(
          Effect.flatMap(dispatch),
          Effect.mapError((cause) => toDispatchError(cause, "Failed to dispatch the command.")),
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        diffs
          .getTurnDiff(input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({ message: "Failed to load turn diff", cause }),
            ),
          ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        diffs.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load thread diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
        projections
          .searchThreads(input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationSearchThreadsError({ message: "Failed to search threads", cause }),
            ),
          ),
      [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
        projections.getArchivedShellSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load archived threads",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
        Stream.unwrap(
          orchestration.subscribeDomainEvents.pipe(
            Effect.flatMap((subscribedEvents) =>
              Effect.gen(function* () {
                if (input.afterSequence !== undefined) {
                  const head = yield* orchestration.latestSequence;
                  const gap = head - input.afterSequence;
                  if (gap >= 0 && gap <= RESUME_MAX_GAP) {
                    const replay = orchestration.readEvents(input.afterSequence, gap).pipe(
                      Stream.mapEffect((event) => projectShellEvent(event, projections)),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: "Failed to resume projects and threads",
                            cause,
                          }),
                      ),
                    );
                    const live = subscribedEvents.pipe(
                      Stream.filter((event) => event.sequence > head),
                      Stream.mapEffect((event) => projectShellEvent(event, projections)),
                    );
                    return Stream.concat(
                      replay,
                      input.requestCompletionMarker
                        ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                        : live,
                    );
                  }
                }
                const snapshot = yield* projections.getShellSnapshot().pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load projects and threads",
                        cause,
                      }),
                  ),
                );
                const live = subscribedEvents.pipe(
                  Stream.filter((event) => event.sequence > snapshot.snapshotSequence),
                  Stream.mapEffect((event) => projectShellEvent(event, projections)),
                );
                return Stream.concat(
                  Stream.make({ kind: "snapshot" as const, snapshot }),
                  input.requestCompletionMarker
                    ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                    : live,
                );
              }),
            ),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
        Stream.unwrap(
          orchestration.subscribeDomainEvents.pipe(
            Effect.flatMap((subscribedEvents) =>
              Effect.gen(function* () {
                const matching = (event: OrchestrationEvent) =>
                  event.aggregateKind === "thread" &&
                  event.aggregateId === input.threadId &&
                  isThreadDetailEvent(event);
                const liveAfter = (sequence: number) =>
                  subscribedEvents.pipe(
                    Stream.filter((event) => event.sequence > sequence && matching(event)),
                    Stream.map((event) => ({
                      kind: "event" as const,
                      event: projectActivityEvent(event),
                    })),
                  );
                if (input.afterSequence !== undefined) {
                  const head = yield* orchestration.latestSequence;
                  const gap = head - input.afterSequence;
                  if (gap >= 0 && gap <= RESUME_MAX_GAP) {
                    const replay = orchestration.readEvents(input.afterSequence, gap).pipe(
                      Stream.filter(matching),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to resume thread ${input.threadId}`,
                            cause,
                          }),
                      ),
                    );
                    const live = liveAfter(head);
                    return Stream.concat(
                      replay,
                      input.requestCompletionMarker
                        ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                        : live,
                    );
                  }
                }
                const snapshot = yield* projections
                  .getThreadDetailSnapshot(
                    input.threadId,
                    input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: `Failed to load thread ${input.threadId}`,
                          cause,
                        }),
                    ),
                  );
                if (Option.isNone(snapshot)) {
                  return yield* new OrchestrationGetSnapshotError({
                    message: `Thread ${input.threadId} was not found`,
                    cause: input.threadId,
                  });
                }
                const live = liveAfter(snapshot.value.snapshotSequence);
                return Stream.concat(
                  Stream.make({
                    kind: "snapshot" as const,
                    snapshot: projectThreadDetailSnapshot(snapshot.value),
                  }),
                  input.requestCompletionMarker
                    ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                    : live,
                );
              }),
            ),
          ),
        ),
    });
  }),
);
