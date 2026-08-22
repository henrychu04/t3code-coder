import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  type OrchestrationShellStreamEvent,
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
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

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
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";

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

export const layer = CoderWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* CoderEnvironment.CoderEnvironment;
    const startup = yield* CoderRuntimeStartup.CoderRuntimeStartup;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
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

    const dispatchBootstrap = (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ) =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...turnStart } = command;
        let createdThread = false;
        const cleanup = () =>
          createdThread
            ? commandId("bootstrap-cleanup").pipe(
                Effect.flatMap((nextCommandId) =>
                  orchestration.dispatch({
                    type: "thread.delete",
                    commandId: nextCommandId,
                    threadId: command.threadId,
                  }),
                ),
                Effect.asVoid,
              )
            : Effect.void;
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
            const worktree = yield* git.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              newRefName: bootstrap.prepareWorktree.branch,
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: null,
            });
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

    const shellEvent = (
      event: OrchestrationEvent,
    ): Effect.Effect<OrchestrationShellStreamEvent> => {
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
          Effect.orElseSucceed(() => ({ kind: "project-removed" as const, sequence, projectId })),
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
        Effect.orElseSucceed(() => ({ kind: "thread-removed" as const, sequence, threadId })),
      );
    };

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
          Effect.gen(function* () {
            const snapshot = yield* projections.getShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load projects and threads",
                    cause,
                  }),
              ),
            );
            const live = orchestration.streamDomainEvents.pipe(Stream.mapEffect(shellEvent));
            if (input.afterSequence !== undefined) {
              const head = yield* orchestration.latestSequence;
              const gap = head - input.afterSequence;
              if (gap >= 0 && gap <= RESUME_MAX_GAP) {
                const replay = orchestration.readEvents(input.afterSequence, gap).pipe(
                  Stream.mapEffect(shellEvent),
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to resume projects and threads",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(
                  replay,
                  input.requestCompletionMarker
                    ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                    : live,
                );
              }
            }
            return Stream.concat(
              Stream.make({ kind: "snapshot" as const, snapshot }),
              input.requestCompletionMarker
                ? Stream.concat(Stream.make({ kind: "synchronized" as const }), live)
                : live,
            );
          }),
        ),
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const matching = (event: OrchestrationEvent) =>
              event.aggregateKind === "thread" &&
              event.aggregateId === input.threadId &&
              isThreadDetailEvent(event);
            const live = orchestration.streamDomainEvents.pipe(
              Stream.filter(matching),
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
    });
  }),
);
