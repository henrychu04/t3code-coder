import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  CommandId,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationV2SearchThreadError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  type ServerLifecycleStreamEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import {
  archivedShellStreamItemFromThreadShell,
  buildActiveShellSnapshot,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadShellSnapshotParts,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import { bufferLiveStream } from "./orchestration-v2/LiveStreamBudget.ts";
import { coalesceThreadLiveStream } from "./orchestration-v2/ThreadLiveEventCoalescer.ts";
import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration-v2/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { refreshPushedPullRequests } from "./git/refreshPushedPullRequests.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import { projectMutationOperation } from "./project/ProjectMutation.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
// Coder: the helper's group, its Coder services, and the fork-only methods.
import { CoderWsRpcGroup } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderRuntimeStartup from "./serverRuntimeStartup.ts";
import * as CoderWs from "./coderWs.ts";
import { exceedsHelperStdioFrame } from "./coderWs.ts";

// Coder: the synthesized ready event carries the current time.
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
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
    // Coder: the path-only FFF service has no directory-read error or cwd on index errors.
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    // Coder: stale writes are rejected by the bounded workspace text editor.
    case "WorkspaceFileStaleError":
      return { failure: "stale_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Coder: the helper serves `CoderWsRpcGroup` without RPC instrumentation or authorization. This
// file builds the upstream methods it carries; `coderWs.ts` builds the fork-only ones.
const ServerWsRpcGroup = CoderWsRpcGroup.omit(...CoderWs.CODER_WS_METHODS);
// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;
// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

export function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

const canReplayPersistedRange = Effect.fnUntraced(function* (
  afterSequence: number,
  headSequence: number,
  maxGap: number,
) {
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const replayGap = headSequence - afterSequence;
  if (replayGap < 0 || replayGap > maxGap) {
    return false;
  }
  const stats = yield* applicationEvents.getReplayStats({
    afterSequence,
    throughSequence: headSequence,
  });
  if (stats.rawPayloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
    yield* Effect.logDebug("orchestration replay replaced by snapshot", {
      afterSequence,
      headSequence,
      replayGap,
      eventCount: stats.eventCount,
      payloadBytes: stats.rawPayloadBytes,
      payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
    });
    return false;
  }
  return true;
});

const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
  (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    Effect.flatMap(ProjectEnrichmentService.ProjectEnrichmentService, (projectEnrichment) =>
      Effect.forEach(
        projects,
        (project) =>
          // Non-blocking: emit with cached identity (or null) and schedule
          // background resolution. subscribeChanges is attached before
          // loadSnapshot, so later identity completions push refreshed
          // shells for multi-env grouping without blocking the initial
          // snapshot or completion marker on slow git probes.
          projectEnrichment.getAvailable(project.workspaceRoot).pipe(
            Effect.map((enrichment) => ({
              project: {
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              },
              repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
            })),
          ),
        { concurrency: 16 },
      ).pipe(
        Effect.map((enriched) => ({
          projects: enriched.map((entry) => entry.project),
          resolvedRepositoryIdentityRoots: enriched
            .filter((entry) => entry.repositoryIdentityResolved)
            .map((entry) => entry.project.workspaceRoot),
        })),
      ),
    ),
);

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
    readonly acceptCompactTurnItems?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: input.acceptCompactTurnItems === true,
          })
        : {
            kind: "snapshot" as const,
            snapshotSequence,
            projection: projectThreadProjectionForWire(snapshot.projection),
          };
      // Coder: the snapshot frame must fit helper stdio before transport encoding.
      if (exceedsHelperStdioFrame(snapshotItem)) {
        return yield* new OrchestrationV2GetThreadProjectionError({
          threadId: input.threadId,
          message: "The thread snapshot exceeds the helper stdio frame limit.",
        });
      }
      return Stream.concat(
        Stream.concat(rpcInitialItems([snapshotItem]), completionMarker),
        eventStreamFrom(snapshotSequence),
      );
    });

    // When the client already holds the projection (cached, or loaded over
    // HTTP) it passes that snapshot's sequence, and we resume by replaying
    // persisted events after it instead of re-sending the (potentially
    // multi-KB) snapshot frame over the socket. The event sink subscribes
    // to live events before reading the persisted tail, so no event
    // published during the replay window is lost; overlapping events are
    // deduped by sequence on the client.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      if (input.afterSequence > highWater) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored JSON before decoding, then check projected event
      // size separately. Neither byte count is a bound on process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // A retained creation can belong to a thread already deleted.
        // Only replace its bounded replay when a snapshot can exist.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replay = yield* loadReplayThrough(input.afterSequence, highWater);
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return Stream.concat(
        Stream.concat(rpcInitialItems(replay), completionMarker),
        eventStreamFrom(highWater),
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  function* (input: {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;

    const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
    const loadProjectMetadataSnapshot = Effect.fn("ws.orchestrationV2.loadProjectMetadataSnapshot")(
      function* (snapshotSequence: number) {
        const enriched = yield* enrichProjectShells(yield* projects.listShells());
        return {
          snapshot: {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence,
            projects: enriched.projects,
            threads: [],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot,
          resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
        };
      },
    );
    const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
      const base = buildActiveShellSnapshot(
        yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "active" }),
          listProjects: projects.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        }),
      );
      const enriched = yield* enrichProjectShells(base.projects);
      const snapshot = { ...base, projects: enriched.projects } as OrchestrationV2ShellSnapshot;
      // Coder: a full shell snapshot must fit one helper stdio frame, including RPC overhead.
      if (exceedsHelperStdioFrame(snapshot)) {
        return yield* new OrchestrationV2GetShellSnapshotError({
          message: "The shell snapshot exceeds the helper stdio frame limit.",
        });
      }
      return {
        snapshot,
        resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
      };
    });
    const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
      stored: Extract<ShellApplicationEvent, { readonly aggregateKind: "project" }>,
    ) {
      if (stored.type === "project.deleted") {
        return {
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        };
      }
      const project = yield* projectService.getShell(stored.aggregateId);
      return Option.match(project, {
        onNone: () => ({
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        }),
        onSome: (value) => ({
          kind: "project.updated" as const,
          sequence: stored.sequence,
          project: value,
        }),
      });
    });

    // Coalescing makes each per-thread shell read represent every event
    // for that thread in the current window; reading only the affected
    // threads keeps the cost of a busy stream independent of how many
    // threads exist overall.
    const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
      events: ReadonlyArray<ShellApplicationEvent>,
    ) {
      return yield* Effect.forEach(
        coalesceShellApplicationEvents(events),
        (stored) =>
          Effect.gen(function* () {
            if ("aggregateKind" in stored) {
              return yield* projectItem(stored);
            }
            const shell = yield* threadManagement.getThreadShell(stored.event.threadId);
            return shellStreamItemFromThreadShell({ stored, shell });
          }),
        { concurrency: 8 },
      );
    });

    const toShellStream = <E, R>(stream: Stream.Stream<ShellApplicationEvent, E, R>) =>
      stream.pipe(
        Stream.groupedWithin(512, Duration.millis(50)),
        Stream.mapEffect((events) => projectShellItems(Array.from(events))),
        Stream.flatMap(Stream.fromIterable),
        skipUnchangedThreadShells,
      );

    const liveFrom = (afterSequence: number) =>
      bufferLiveStream(
        toShellStream(
          applicationEvents.streamProjectedApplicationEvents({
            afterSequence,
            project: toShellApplicationEvent,
          }),
        ),
      );

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
      // Build the refresh from the identities the changes carry. Re-enriching
      // every project here re-requested each expired root, whose resolution
      // published again, so one expiry kept every subscriber reloading every
      // project's metadata once a minute.
      Stream.mapEffect((changes) =>
        Effect.gen(function* () {
          const identities = new Map(
            Array.from(changes, (change) => [
              change.workspaceRoot,
              change.enrichment.repositoryIdentity,
            ]),
          );
          const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
          const changedProjects = (yield* projects.listShells()).flatMap((project) =>
            identities.has(project.workspaceRoot)
              ? [{ ...project, repositoryIdentity: identities.get(project.workspaceRoot) ?? null }]
              : [],
          );
          return shellStreamItemFromEnrichmentRefresh({
            snapshot: {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence,
              projects: changedProjects,
              threads: [],
              archivedThreads: [],
            } as OrchestrationV2ShellSnapshot,
            changes: Array.from(changes),
          });
        }),
      ),
    );

    // Always attach the enrichment subscription before the first load so
    // completions that race HTTP snapshot fetch still push a refresh.
    // When the client already holds a shell snapshot (cached, or loaded
    // over HTTP) it passes that snapshot's sequence. We still emit one
    // compact metadata refresh up front: getAvailable may have been cold on the
    // HTTP path (null identity), and enrichment PubSub events published
    // before this subscribe attached are dropped. Rehydrating here fills
    // repositoryIdentity for cross-environment project grouping even on
    // afterSequence resumes. Application events after the sequence still
    // stream as deltas; overlapping events are deduped by sequence on the
    // client.
    //
    // After the unmarked authoritative frame, emit a same-sequence
    // metadata-only frame for roots that already resolved successfully
    // (including cached null). Cold/failed roots stay unmarked and use
    // the PubSub enrichment path when they complete later.
    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;
    const initialSnapshotItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    const initialEnrichmentItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromResumeSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    // Initial unmarked (+ optional same-load marked) always drains first.
    // Enrichment merges only with the post-prefix tail so a ready marked
    // refresh cannot interleave before the authoritative initial frame.
    const completionThenLive = (afterSequence: number) =>
      Stream.concat(completionMarker, liveFrom(afterSequence));

    const stream = yield* Effect.gen(function* () {
      if (input.afterSequence === undefined) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const highWater = yield* applicationEvents.latestApplicationSequence;
      if (!(yield* canReplayPersistedRange(input.afterSequence, highWater, SHELL_RESUME_MAX_GAP))) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      const replay = toShellStream(
        applicationEvents.readApplicationEvents({
          afterSequence: input.afterSequence,
          throughSequence: highWater,
        }),
      );
      return composeShellStreamWithEnrichment({
        initial: initialEnrichmentItems(loaded),
        tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
        enrichment: enrichmentRefreshes,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to prepare the application shell stream",
            cause,
          }),
      ),
    );

    return stream.pipe(
      dedupeShellEnrichment,
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed while streaming the application shell",
            cause,
          }),
      ),
    );
  },
);

// Coder: helper stdio has no session, client origin, analytics, preview automation, or server
// browser.
const layerWsRpc = () =>
  // Coder: serve the whole helper group; the fork-only methods join at the end.
  CoderWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const intakeContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
      >();
      // Coder: the shell, thread, and archive streams take their services from this context.
      const streamContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | OrchestrationEventStore.OrchestrationEventStore
        | ProjectStore.ProjectStoreV2
        | ProjectService.ProjectService
        | ProjectEnrichmentService.ProjectEnrichmentService
        | SqlClient.SqlClient
      >();
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const projectService = yield* ProjectService.ProjectService;
      const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const threadSearch = yield* ThreadSearch.ThreadSearch;

      const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
      // Coder: helper stdio has no client-origin attribution or analytics. Thread merge-request
      // links must belong to a known GitLab host.
      const ensureCoderPullRequestLink = CoderWs.makeEnsureCoderPullRequestLink(projectStore);
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
      const crypto = yield* Crypto.Crypto;
      const serverCommandId = (tag: string) =>
        crypto.randomUUIDv4.pipe(
          Effect.orDie,
          Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
        );
      const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
        reference.host !== undefined && reference.repository.includes("/")
          ? Effect.succeed(pullRequestSyncKey(reference))
          : projectService.getShell(reference.projectId).pipe(
              Effect.map((project) =>
                pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
              ),
              Effect.orElseSucceed(() => null),
            );
      const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const storageCleanup = yield* StorageCleanup.StorageCleanup;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      // Coder: complete workspace startup before accepting helper RPC commands; this replaces
      // upstream's startup command queue.
      yield* CoderRuntimeStartup.CoderRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      // Coder: the descriptor comes from the authenticated Linux Coder workspace.
      const environment = yield* CoderEnvironment.CoderEnvironment;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      // Coder: GitLab uses the workspace glab login; no viewer routing credential exists.
      const withPullRequestViewer = <T>(_reference: unknown, effect: T) => effect;

      // Coder: publish the trimmed workspace config without auth, editors, telemetry, or usage limits.
      const loadServerConfig = Effect.gen(function* () {
        // Coder: the trimmed config RPC cannot expose keybinding-load errors; preserve defaults on failure.
        const keybindingsConfig = yield* keybindings.loadConfigState.pipe(
          Effect.orElseSucceed(() => ({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS, issues: [] })),
        );
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
        return {
          environment: environment.descriptor,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          settings,
          reasoningMessages: true,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
          threadFind: true,
          threadFindProgressive: true,
          ...Option.match(scratchWorkspaceRoot, {
            onNone: () => ({}),
            onSome: (root) => ({ scratchWorkspaceRoot: root }),
          }),
          newProjectsRoot: managedFolders.namedProjectsRoot,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const getOrchestrationV2ArchivedShellSnapshot = Effect.gen(function* () {
        const { threads, projects, snapshotSequence } = yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "archive" }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        });
        return {
          schemaVersion: threads.schemaVersion,
          snapshotSequence,
          projects,
          threads: threads.archivedThreads,
        } as const;
      }).pipe(
        Effect.flatMap((snapshot) =>
          enrichProjectShells(snapshot.projects).pipe(
            Effect.map(({ projects }) => ({ ...snapshot, projects })),
          ),
        ),
        Effect.provide(streamContext),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load archived thread snapshot",
              cause,
            }),
        ),
      );

      const subscribeOrchestrationV2ArchivedShell = Effect.fn(
        "ws.orchestrationV2.subscribeArchivedShell",
      )(function* () {
        const snapshot = yield* getOrchestrationV2ArchivedShellSnapshot;
        const live = threadManagement
          .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
          .pipe(
            Stream.groupedWithin(512, Duration.millis(50)),
            Stream.mapEffect((events) =>
              Effect.forEach(
                coalesceStoredThreadEvents(Array.from(events)),
                (stored) =>
                  threadManagement
                    .getThreadShell(stored.event.threadId)
                    .pipe(
                      Effect.map((shell) =>
                        archivedShellStreamItemFromThreadShell({ stored, shell }),
                      ),
                    ),
                { concurrency: 8 },
              ),
            ),
            Stream.flatMap(Stream.fromIterable),
            Stream.filterMap((item) => (item === null ? Result.failVoid : Result.succeed(item))),
            (stream) => bufferLiveStream(stream),
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming archived threads",
                  cause,
                }),
            ),
          );
        return Stream.concat(rpcInitialItems([{ kind: "snapshot" as const, snapshot }]), live);
      });

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        const result = yield* projectMutationOperation(projectService, mutation);
        if (mutation.type === "project.delete")
          yield* projectCloneTracker.discard(mutation.projectId);
        return result;
      });

      const handlers = ServerWsRpcGroup.of({
        // Coder: check merge-request links first; no command queue or client analytics.
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": command.commandId,
            "orchestration_v2.command_type": command.type,
            "orchestration_v2.thread_id":
              command.type === "thread.fork" || command.type === "thread.merge_back"
                ? command.targetThreadId
                : command.type === "delegated_task.request" ||
                    command.type === "delegated_task.wake-policy" ||
                    command.type === "delegated_task.completion-delivery.acknowledge" ||
                    command.type === "delegated_task.completion-delivery.dispose" ||
                    command.type === "thread.created.record"
                  ? command.parentThreadId
                  : command.threadId,
            ...(command.type === "thread.fork" || command.type === "thread.merge_back"
              ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
              : {}),
          }).pipe(
            Effect.andThen(
              ensureCoderPullRequestLink(command).pipe(
                Effect.andThen(
                  // A retry also restarts the preparation work the launch owns.
                  (command.type === "prepared-run.retry"
                    ? threadLaunch.retryPreparation(command)
                    : ThreadMessageIntake.dispatchCommand(
                        ThreadManagementService.withCreationProvenance(command, {
                          createdBy: "user",
                          creationSource:
                            "creationSource" in command ? command.creationSource : "web",
                        }),
                      )
                  ).pipe(Effect.provide(intakeContext)),
                ),
                Effect.map((result) => ({ sequence: result.sequence })),
                Effect.mapError((cause) => {
                  if (cause instanceof OrchestrationV2DispatchCommandError) return cause;
                  const detail = userFacingDispatchErrorMessage(cause);
                  return new OrchestrationV2DispatchCommandError({
                    commandId: command.commandId,
                    commandType: command.type,
                    message: detail ?? "Failed to dispatch orchestration V2 command",
                    ...(detail === undefined ? {} : { detail }),
                    cause,
                  });
                }),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          readWorkflowScript({ scriptPath: input.scriptPath }),
        [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
          threadManagement.getTurnItem(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: "Failed to load turn item",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
          threadManagement
            .searchThread(input)
            .pipe(Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
        [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
          threadManagement
            .searchThreadStream(input)
            .pipe(Stream.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          threadSearch.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationSearchThreadsError({
                  message: "Failed to search threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          getOrchestrationV2ArchivedShellSnapshot,
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              // Pre-pagination clients still call this compatibility endpoint.
              // Keep stale clients from materializing an unbounded transcript.
              threadManagement
                .getThreadSnapshotWindow(input.threadId, {
                  rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
                })
                .pipe(
                  Effect.map((snapshot) =>
                    projectThreadProjectionForWire(
                      buildBoundedThreadProjection({
                        projection: snapshot.projection,
                        snapshotSequence: snapshot.snapshotSequence,
                      }).projection,
                    ),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationV2GetThreadProjectionError({
                        threadId: input.threadId,
                        message: `Failed to load orchestration V2 thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
            ),
          ),
        // Coder: no startup command queue or client analytics.
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": input.commandId,
            "orchestration_v2.project_id": input.projectId,
          }).pipe(
            Effect.andThen(
              ThreadMessageIntake.launchThread({
                commandId: input.commandId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.reuseExistingThread === undefined
                  ? {}
                  : { reuseExistingThread: input.reuseExistingThread }),
                projectId: input.projectId,
                title: input.title,
                ...(input.generateTitle === undefined
                  ? {}
                  : { generateTitle: input.generateTitle }),
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                workspaceStrategy: input.workspaceStrategy,
                ...(input.initialMessage === undefined
                  ? {}
                  : {
                      initialMessage: {
                        ...(input.initialMessage.messageId === undefined
                          ? {}
                          : { messageId: input.initialMessage.messageId }),
                        text: input.initialMessage.text,
                        attachments: input.initialMessage.attachments,
                        ...(input.initialMessage.context === undefined
                          ? {}
                          : { context: input.initialMessage.context }),
                      },
                    }),
                createdBy: "user",
                creationSource: input.creationSource ?? "web",
              }).pipe(
                Effect.provide(intakeContext),
                Effect.map((result) => ({
                  ...result,
                  projection: projectThreadProjectionForWire(result.projection),
                })),
                Effect.catchTags({
                  AttachmentClaimError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: cause.message,
                      cause,
                    }),
                  ThreadLaunchError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: "Failed to launch thread",
                      cause,
                    }),
                }),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: (_input) =>
          Stream.unwrap(subscribeOrchestrationV2ArchivedShell()),
        // Coder: the stream takes its services from `streamContext`.
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          Stream.unwrap(subscribeOrchestrationV2Shell(input).pipe(Effect.provide(streamContext))),
        // Coder: the stream takes its services from `streamContext`.
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              Effect.andThen(
                subscribeOrchestrationV2Thread(input).pipe(Effect.provide(streamContext)),
              ),
            ),
          ),
        // Coder: helper stdio has no session scopes, so every webhook URL is visible.
        [WS_METHODS.scheduledTasksList]: (_input) => scheduledTasks.list(),
        // Coder: helper stdio has no session scopes, so every webhook URL is visible.
        [WS_METHODS.scheduledTasksSubscribe]: (_input) => scheduledTasks.subscribeList(),
        [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.setEnabled(input)),
          ),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.delete(input)),
          ),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.runNow(input)),
          ),
        [WS_METHODS.secretsAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(secretRequests.answer(input)),
          ),
        [WS_METHODS.serverProbe]: (_input) => Effect.succeed({}),
        // Coder: the trimmed workspace config.
        [WS_METHODS.serverGetConfig]: (_input) => loadServerConfig,
        // Coder: refresh workspace providers without remote manifests or unsupported usage/model refreshes.
        [WS_METHODS.serverRefreshProviders]: (input) =>
          Effect.gen(function* () {
            const providers = yield* input.cwd !== undefined && input.instanceId !== undefined
              ? providerRegistry.refreshWorkspaceSnapshot({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                  fresh: input.fresh === true,
                })
              : input.instanceId !== undefined
                ? providerRegistry.refreshInstance(input.instanceId)
                : providerRegistry.refresh();
            return { providers };
          }),
        [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
        [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
        [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
        [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          providerMaintenanceRunner.updateProvider(input),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
        [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
        [WS_METHODS.serverGetSettings]: (_input) =>
          serverSettings.getSettings.pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
        // Coder: workspace settings have no device hosts to resolve.
        [WS_METHODS.serverUpdateSettings]: ({ patch, providerInstanceMutation }) =>
          Effect.gen(function* () {
            const settings = yield* providerInstanceMutation === undefined
              ? serverSettings.updateSettings(patch)
              : serverSettings.updateProviderInstance(providerInstanceMutation, patch);
            return ServerSettings.redactServerSettingsForClient(settings);
          }),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
        [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
        [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          withPullRequestViewer(input, pullRequests.summary(input)),
        [WS_METHODS.pullRequestsStack]: (input) =>
          withPullRequestViewer(input, pullRequests.stack(input)),
        [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
          resolvePullRequestSyncKey(input).pipe(
            Effect.flatMap((key) =>
              key === null
                ? Effect.succeed({ threads: [] })
                : listLinkedPullRequestThreads(key).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
            ),
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          withPullRequestViewer(input, pullRequests.detail(input)),
        [WS_METHODS.pullRequestsPreview]: (input) =>
          withPullRequestViewer(input, pullRequests.preview(input)),
        [WS_METHODS.pullRequestsChecks]: (input) =>
          withPullRequestViewer(input, pullRequests.checks(input)),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          withPullRequestViewer(input, pullRequests.activity(input)),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          withPullRequestViewer(input, pullRequests.threadComments(input)),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          withPullRequestViewer(input, pullRequests.diffFileContents(input)),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.filesViewed(input)),
        [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
            Effect.tap(() =>
              resolvePullRequestSyncKey(input).pipe(
                Effect.flatMap((key) =>
                  key === null ? Effect.void : pullRequestSync.requestSync(key),
                ),
              ),
            ),
          ),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          withPullRequestViewer(input, pullRequests.update(input)),
        [WS_METHODS.pullRequestsComment]: (input) =>
          withPullRequestViewer(input, pullRequests.comment(input)),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          withPullRequestViewer(input, pullRequests.updateComment(input)),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          withPullRequestViewer(input, pullRequests.submitReview(input)),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          withPullRequestViewer(input, pullRequests.replyToThread(input)),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          withPullRequestViewer(input, pullRequests.setReaction(input)),
        [WS_METHODS.pullRequestsReportState]: (input) => pullRequests.reportState(input),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          pullRequests.invalidate(input, { notifyReaders: true }).pipe(
            // A reader asking for fresh host state also wants the thread badges it feeds to
            // catch up, including a merged link the sweep would otherwise never revisit.
            Effect.andThen(
              input.reference === undefined || input.filesViewedOnly === true
                ? Effect.void
                : resolvePullRequestSyncKey(input.reference).pipe(
                    Effect.flatMap((key) =>
                      key === null ? Effect.void : pullRequestSync.requestSync(key),
                    ),
                  ),
            ),
          ),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          withPullRequestViewer(input, pullRequests.requestReviewers(input)),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.labelCandidates(input)),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          withPullRequestViewer(input, pullRequests.setLabels(input)),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          sourceControlRepositories.lookupRepository(input),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          sourceControlRepositories.cloneRepository(input),
        [WS_METHODS.projectCloneStart]: (input) =>
          projectCloneTracker.start(input, {
            createProject: (project) =>
              projectService
                .create({
                  commandId: CommandId.make(`project-clone-create:${project.projectId}`),
                  projectId: project.projectId,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  createWorkspaceRootIfMissing: true,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationDispatchCommandError({
                        message: "Failed to create clone project.",
                        cause,
                      }),
                  ),
                ),
            onCloned: (project) =>
              repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
                Effect.andThen(
                  projectService.update({
                    commandId: CommandId.make(`project-clone-done:${project.projectId}`),
                    projectId: project.projectId,
                  }),
                ),
                Effect.andThen(refreshGitStatus(project.workspaceRoot)),
                Effect.ignoreCause({ log: true }),
              ),
          }),
        [WS_METHODS.projectsEnsureScratch]: () =>
          managedFolders.ensureScratchProject.pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
        [WS_METHODS.projectsCreateNew]: (input) =>
          managedFolders
            .createNamedProject(input)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectCloneCancel]: (input) =>
          projectCloneTracker.cancel(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.projectCloneRetry]: (input) =>
          projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.subscribeProjectClones]: () => projectCloneTracker.stream,
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          sourceControlRepositories.publishRepository(input).pipe(
            // A new remote can change the cached identity. Only the `cwd` entry
            // refreshes, so after a publish from a linked worktree the project
            // root entry waits for its TTL.
            Effect.tap(() => repositoryIdentityResolver.resolve(input.cwd, { refresh: true })),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
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
        [WS_METHODS.projectsListEntries]: (input) =>
          workspaceEntries.list(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          workspaceFileSystem.readFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectReadFileError({
                  ...input,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        // Coder: no startup command queue; workspace startup completes before this layer is built.
        [WS_METHODS.projectsMutate]: (mutation) =>
          mutateProject(mutation).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectMutationError({
                  commandId: mutation.commandId,
                  message:
                    cause._tag === "ProjectNotEmptyError"
                      ? cause.message
                      : "Failed to mutate project.",
                  cause,
                }),
            ),
          ),
        [WS_METHODS.filesystemGetMetadata]: (input) => workspaceFileSystem.getMetadata(input),
        [WS_METHODS.filesystemBrowse]: (input) =>
          workspaceEntries.browse(input).pipe(
            Effect.mapError(
              (cause) =>
                new FilesystemBrowseError({
                  ...input,
                  ...filesystemBrowseFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
        [WS_METHODS.agentSessionsImport]: (input) =>
          agentSessionImporter.importRecentAgentThreads(input),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          vcsStatusBroadcaster.streamStatus(input, {
            automaticRemoteRefreshInterval: automaticGitFetchInterval,
          }),
        [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          worktreeSetupTracker
            .cancel(input.threadId)
            .pipe(Effect.map((cancelled) => ({ cancelled }))),
        [WS_METHODS.vcsRefreshStatus]: (input) => vcsStatusBroadcaster.refreshStatus(input.cwd),
        [WS_METHODS.vcsPull]: (input) =>
          gitWorkflow.pullCurrentBranch(input.cwd).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: (result) =>
                refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
            }),
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            gitWorkflow
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: (result) =>
                    (input.threadId === undefined
                      ? Effect.void
                      : linkCreatedPullRequest({
                          threadId: input.threadId,
                          result,
                          commandId: serverCommandId("pr-created-link"),
                        }).pipe(
                          Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                          Effect.provideService(ProjectService.ProjectService, projectService),
                        )
                    ).pipe(
                      Effect.andThen(
                        refreshPushedPullRequests(input, result).pipe(
                          Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                          Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                          Effect.provideService(
                            PullRequestService.PullRequestService,
                            pullRequests,
                          ),
                        ),
                      ),
                      Effect.andThen(refreshGitStatus(input.cwd)),
                      Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                    ),
                }),
              ),
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) => gitWorkflow.resolvePullRequest(input),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          gitWorkflow
            .preparePullRequestThread(input)
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsCreateRef]: (input) =>
          gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsInit]: (input) =>
          vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
        [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
        [WS_METHODS.terminalAttach]: (input) =>
          Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
            Effect.acquireRelease(
              terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
          ),
        [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
        [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
        [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
        [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
        [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
        [WS_METHODS.terminalObserve]: (input) =>
          Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
            Effect.acquireRelease(
              terminalManager.observeStream(input, (event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        // Coder: preserve bounded helper stdio streams and reconnect snapshots.
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Coder: API-only providers have no subscription quota sources or usage-limit commands.
              const config = yield* loadServerConfig;
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = Stream.concat(
                Stream.fromEffect(providerRegistry.getProviders),
                providerRegistry.streamChanges,
              ).pipe(
                // Both sides replay their current value, so the first pairing normally
                // repeats the snapshot the client already holds. Compare against that
                // snapshot rather than dropping blindly: a refresh that landed between
                // the snapshot and the subscription still goes out.
                (updates) => Stream.concat(Stream.make(config.providers), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(settingsUpdates, environmentThemeUpdates),
                ),
              );

              return Stream.concat(
                Stream.make({ version: 1 as const, type: "snapshot" as const, config }),
                liveUpdates,
              );
            }),
          ),
        // Coder: synthesize welcome/ready from workspace projections because helper lifecycle has no
        // startup publisher. Legacy thread migration progress still comes from the lifecycle events.
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const lifecycleSnapshot = yield* lifecycleEvents.snapshot;
              const project = yield* projectStore
                .findActiveByWorkspaceRoot(config.cwd)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              const bootstrapProjectId = Option.isSome(project)
                ? project.value.projectId
                : undefined;
              const thread = bootstrapProjectId
                ? yield* threadManagement.getShellSnapshot({ location: "active" }).pipe(
                    Effect.map((shell) =>
                      shell.threads.find(
                        (candidate) =>
                          candidate.projectId === bootstrapProjectId &&
                          candidate.lineage.relationshipToParent !== "subagent",
                      ),
                    ),
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;
              // Migration events follow the synthesized welcome and ready events.
              const migrationEvent = (event: ServerLifecycleStreamEvent) =>
                event.type === "legacyThreadMigration"
                  ? [{ ...event, sequence: event.sequence + 2 }]
                  : [];
              const snapshotEvents = Array.from(lifecycleSnapshot.events)
                .toSorted((left, right) => left.sequence - right.sequence)
                .flatMap(migrationEvent);
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > lifecycleSnapshot.sequence),
                Stream.flatMap((event) => Stream.fromIterable(migrationEvent(event))),
              );
              return Stream.concat(
                Stream.make(
                  {
                    version: 1 as const,
                    sequence: 1,
                    type: "welcome" as const,
                    payload: {
                      environment: environment.descriptor,
                      cwd: config.cwd,
                      projectName: config.cwd.split("/").filter(Boolean).at(-1) ?? "workspace",
                      ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
                      ...(thread ? { bootstrapThreadId: thread.id } : {}),
                    },
                  },
                  {
                    version: 1 as const,
                    sequence: 2,
                    type: "ready" as const,
                    payload: { at: yield* nowIso, environment: environment.descriptor },
                  },
                  ...snapshotEvents,
                ),
                liveEvents,
              );
            }),
          ),
      });
      // Coder: add the fork-only methods and verify Files roots before upstream's Files handlers.
      return CoderWsRpcGroup.of({
        ...handlers,
        ...(yield* CoderWs.makeHandlers(handlers, {
          serverCommandId,
          refreshGitStatus,
          projectFileFailureContext,
        })),
      });
    }),
  );

// A defect in a handler's effect fails only its own request. RpcServer's default
// sends a socket-level Defect frame instead, and the client ends every pending
// request on the socket with it. DefectReporter logs these defects.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

// Coder: the helper stdio bridge serves this layer; there is no /ws route.
export const layer = layerWsRpc();
