import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import {
  AcpRegistryOperationError,
  CommandId,
  type GitActionProgressEvent,
  type AcpRegistryImportSessionInput,
  type AcpRegistryListSessionsInput,
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
  type DiscoveredLocalServerList,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadStreamItem,
  type ApplicationStoredEvent,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  type ServerLifecycleStreamEvent,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { RpcGroup } from "effect/rpc";

import { isNetworkPath } from "@t3tools/shared/path";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import {
  bufferShellLiveStream,
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadOlderSettledThreadsPage,
  loadShellSnapshotParts,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  loadSubscriberShellSnapshot,
  shellStreamItemsFromResumeSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
} from "./orchestration-v2/ThreadLiveEventCoalescer.ts";
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
  makeLiveBodyDeduper,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { latestProviderVersionCacheKeys } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { terminalOutputStream } from "./terminal/OutputProtocol.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
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
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import { mutateProjectWithClone } from "./project/ProjectMutation.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
// Coder: the helper's group, its Coder services, and the fork-only methods.
import { CoderWsRpcGroup } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderRuntimeStartup from "./serverRuntimeStartup.ts";
import * as CoderWs from "./coderWs.ts";
import { exceedsHelperStdioFrame } from "./coderWs.ts";

// Coder: the synthesized ready event carries the current time.
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withoutWorkspaceSnapshots(providers: ReadonlyArray<ServerProvider>): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

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
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
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
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
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
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Coder: the helper serves `CoderWsRpcGroup` without RPC instrumentation or authorization. This
// file builds the upstream methods it carries; `coderWs.ts` builds the fork-only ones.
const ServerWsRpcGroup = CoderWsRpcGroup.omit(...CoderWs.CODER_WS_METHODS);

// RpcGroup.toLayer derives each handler's requirements by scanning every RPC in
// the group, so its type cost grows with handlers × RPCs. Near 200 methods that
// crosses TypeScript's instantiation limit and the layer's requirements degrade to
// `any`, so the handlers are registered as two disjoint, smaller groups.
// Coder: the split covers the whole helper group, fork-only methods included.
type ServerWsRpc = RpcGroup.Rpcs<typeof CoderWsRpcGroup>;
const SPLIT_WS_RPC_PREFIXES = ["server", "pullRequests", "provider", "orchestration"] as const;
type SplitWsRpc = Extract<
  ServerWsRpc,
  { readonly _tag: `${(typeof SPLIT_WS_RPC_PREFIXES)[number]}.${string}` }
>;
const isSplitWsRpc = (rpc: ServerWsRpc): rpc is SplitWsRpc =>
  SPLIT_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`));
const isOtherWsRpc = (rpc: ServerWsRpc): rpc is Exclude<ServerWsRpc, SplitWsRpc> =>
  !isSplitWsRpc(rpc);
const serverWsRpcs = Array.from(CoderWsRpcGroup.requests.values());
const SplitWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isSplitWsRpc));
const OtherWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isOtherWsRpc));
// Replaying each intervening event costs a shell refetch; past this gap a
// single O(active-threads) snapshot is cheaper and bounded.
const SHELL_RESUME_MAX_GAP = 1_000;
// Row counts do not bound large tool payloads; sum stored JSON bytes in SQL and snapshot above budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
  readonly acceptDeferredWork?: boolean;
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
    readonly acceptDeferredWork?: boolean;
    readonly acceptCompactTurnItems?: boolean;
    readonly acceptDedupedBodies?: boolean;
    readonly acceptCompactIds?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const dedupeBodies = input.acceptDedupedBodies === true;
    // Replay, snapshot, and live tail share one deduper: it must see every delivered record.
    const withLiveDedupe = <E, R>(stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>) =>
      dedupeBodies ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper())) : stream;
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
          // Downgrades can leave unknown rows; skip them and resume live from highWater so later events survive.
          skipUnknownEventTypes: true,
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
              deferWork: input.acceptDeferredWork === true,
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
            dedupeBodies,
            compactIds: input.acceptCompactIds === true,
          })
        : (() => {
            const projection = projectThreadProjectionForWire(snapshot.projection);
            return {
              kind: "snapshot" as const,
              snapshotSequence,
              projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
            };
          })();
      // Coder: the snapshot frame must fit helper stdio before transport encoding.
      if (exceedsHelperStdioFrame(snapshotItem)) {
        return yield* new OrchestrationV2GetThreadProjectionError({
          threadId: input.threadId,
          message: "The thread snapshot exceeds the helper stdio frame limit.",
        });
      }
      return rpcInitialItems([snapshotItem]).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(snapshotSequence)),
        withLiveDedupe,
      );
    });

    // Subscribe before reading persisted events to retain concurrent publishes; clients dedupe overlap by sequence.
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
      // Bound stored and projected payload bytes separately; neither bounds process memory.
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
        // Retained creation events may describe deleted threads; replace replay only if a snapshot exists.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replay = coalesceLiveUpdatedEvents(
        yield* loadReplayThrough(input.afterSequence, highWater),
      );
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return rpcInitialItems(replay).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(highWater)),
        withLiveDedupe,
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  function* (input: {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly omitIdleSubagents?: boolean;
    readonly omitOlderSettled?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    let subagentThreadIds = new Set<string>();
    const filterSubagentTranscript = (stored: ApplicationStoredEvent) =>
      shouldPublishShellApplicationEvent(stored, subagentThreadIds);

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
      const forSubscriber = yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex: threadManagement.listActiveShellIndex(),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: projects.listShells(),
        latestSequence: applicationEvents.latestApplicationSequence,
        options: {
          omitIdleSubagents: input.omitIdleSubagents === true,
          omitOlderSettled: input.omitOlderSettled === true,
        },
      });
      subagentThreadIds = forSubscriber.subagentThreadIds;
      const enriched = yield* enrichProjectShells(forSubscriber.snapshot.projects);
      const snapshot = {
        ...forSubscriber.snapshot,
        projects: enriched.projects,
      } as OrchestrationV2ShellSnapshot;
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
      bufferShellLiveStream(
        toShellStream(
          applicationEvents.streamProjectedApplicationEvents({
            afterSequence,
            project: toShellApplicationEvent,
            filter: filterSubagentTranscript,
          }),
        ),
      );

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
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

    // Subscribe before loading for racing enrichments; initial refresh covers pre-subscription completions and cold HTTP snapshots.
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
    // Drain initial frames before merging enrichment with live events so marked refreshes cannot precede the initial frame.
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

      subagentThreadIds = new Set(yield* threadManagement.listActiveSubagentThreadIds());

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      const replay = toShellStream(
        applicationEvents
          .readApplicationEvents({
            afterSequence: input.afterSequence,
            throughSequence: highWater,
            // A row a newer build wrote (e.g. after a downgrade) must not fail
            // every shell resubscribe. The live tail below resumes from
            // highWater, so a dropped row never hides later events.
            skipUnknownEventTypes: true,
          })
          .pipe(Stream.filter(filterSubagentTranscript)),
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
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const intakeContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
        | ServerSettings.ServerSettingsService
        | DocumentText.DocumentText
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
      const scratchThreadPromotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const threadSearch = yield* ThreadSearch.ThreadSearch;

      const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
      // Coder: helper stdio has no client-origin attribution or analytics.
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
      const crypto = yield* Crypto.Crypto;
      // RPC client ids are only unique within one socket; terminals share viewers across sockets.
      const terminalViewerPrefix = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const terminalViewerId = (metadata: { readonly client: { readonly id: number } }) =>
        `${terminalViewerPrefix}:${metadata.client.id}`;
      const serverCommandId = (tag: string) =>
        crypto.randomUUIDv4().pipe(
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
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
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
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      // Coder: of upstream's ACP Registry services, only the runtime coordinator is used here.
      const acpRegistryRuntimeCoordinator =
        yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const providerLatestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
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
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      // Coder: GitLab uses the workspace glab login; no viewer routing credential exists.
      const withPullRequestViewer = <T>(_reference: unknown, effect: T) => effect;

      // Coder: of upstream's ACP Registry handlers, only Kilo Code's native session list and
      // import are carried.
      const acpRegistryProject = Effect.fn("ws.acpRegistry.project")(function* (
        projectId: ProjectId,
      ) {
        const project = yield* projectService.getById(projectId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "project_not_found",
                message: `Project ${projectId} is unavailable.`,
                cause,
              }),
          ),
        );
        return yield* Effect.fromOption(
          project,
          () =>
            new AcpRegistryOperationError({
              reason: "project_not_found",
              message: `Project ${projectId} was not found.`,
            }),
        );
      });

      const acpSessionManager = Effect.fn("ws.acpRegistry.sessionManager")(function* (
        instanceId: ProviderInstanceId,
      ) {
        const instance = yield* providerInstances.getInstance(instanceId);
        if (instance === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "instance_not_found",
            message: `Provider instance ${instanceId} was not found.`,
          });
        }
        if (instance.acpSessionManagement === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "session_list_unsupported",
            message: `Provider instance ${instanceId} does not expose ACP session management.`,
          });
        }
        return { instance, manager: instance.acpSessionManagement };
      });

      const importedAcpThreadId = (input: {
        readonly driver: ProviderDriverKind;
        readonly instanceId: ProviderInstanceId;
        readonly sessionId: string;
      }) =>
        IdAllocator.deriveThreadFromProviderThread({
          driver: input.driver,
          providerInstanceId: input.instanceId,
          nativeThreadId: input.sessionId,
        });

      const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
        input: AcpRegistryListSessionsInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const listed = yield* manager.listSessions({
          cwd: project.workspaceRoot,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const sessions = yield* Effect.forEach(
          listed.sessions,
          (session) => {
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: session.sessionId,
            });
            return threadManagement.getThreadShell(threadId).pipe(
              Effect.map((thread) => ({
                ...session,
                importedThreadId: thread === null ? null : threadId,
              })),
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect existing imported ACP sessions.",
                    cause,
                  }),
              ),
            );
          },
          { concurrency: 16 },
        );
        return { ...listed, sessions };
      });

      const importAcpRegistrySession = Effect.fn("ws.acpRegistry.importSession")(function* (
        input: AcpRegistryImportSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            yield* acpRegistryProject(input.projectId);
            const { instance } = yield* acpSessionManager(input.instanceId);
            const providerSnapshot = yield* instance.snapshot.getSnapshot;
            if (
              providerSnapshot.nativeSessions?.canLoad !== true &&
              providerSnapshot.nativeSessions?.canResume !== true
            ) {
              return yield* new AcpRegistryOperationError({
                reason: "session_resume_unsupported",
                message: "The ACP agent cannot load or resume native sessions.",
              });
            }
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            });
            const existing = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (existing !== null) return { threadId, imported: false } as const;

            const provider = (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === input.instanceId,
            );
            const model =
              provider?.models.find((candidate) => candidate.isDefault)?.slug ??
              provider?.models[0]?.slug ??
              "default";
            const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
            // Coder: no startup command queue; workspace startup completes before this layer is
            // built.
            const launched = yield* Effect.result(
              threadLaunch.launch({
                commandId,
                threadId,
                projectId: input.projectId,
                title: input.title ?? "Imported ACP session",
                modelSelection: { instanceId: input.instanceId, model },
                runtimeMode: "approval-required",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                importedNativeThread: {
                  ref: {
                    driver: instance.driverKind,
                    nativeId: input.sessionId,
                    strength: "strong",
                  },
                  metadata: {
                    itemIdentityVersion: 2,
                    ...(input.title === undefined ? {} : { title: input.title }),
                    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                  },
                },
                createdBy: "user",
                creationSource: "web",
              }),
            );
            if (Result.isFailure(launched)) {
              const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "session_import_failed",
                      message: "Could not inspect the imported ACP session after launch failed.",
                      cause,
                    }),
                ),
              );
              if (racedImport !== null) return { threadId, imported: false } as const;
              return yield* new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not create a T3 thread for the ACP session.",
                cause: launched.failure,
              });
            }
            return { threadId, imported: true } as const;
          }),
        );
      });

      // Coder: publish the trimmed workspace config without auth, editors, telemetry, usage
      // limits, or event-loop stall notices.
      const loadServerConfig = Effect.fn("ws.loadServerConfig")(function* (options: {
        readonly workspaceSnapshotsOnDemand: boolean;
      }) {
        // Coder: the trimmed config RPC cannot expose keybinding-load errors; preserve defaults on failure.
        const keybindingsConfig = yield* keybindings.loadConfigState.pipe(
          Effect.orElseSucceed(() => ({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS, issues: [] })),
        );
        const currentProviders = yield* providerRegistry.getProviders;
        const providers = options.workspaceSnapshotsOnDemand
          ? withoutWorkspaceSnapshots(currentProviders)
          : currentProviders;
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
          shellThreadFamilies: true,
          shellOlderSettled: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
          threadFind: true,
          threadFindProgressive: true,
          secretProviderSettings: true,
          // Coder: no secret provider is loaded, so settings never point at one (`secretReferences`).
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

      // Rows the shell can omit, read with the same snapshot sequence the shell uses.
      const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(
        function* (
          options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
          message: string,
        ) {
          const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
            sql,
            readThreads: threadManagement.readShellSnapshot({ location: "active", ...options }),
            listProjects: Effect.succeed([]),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) => new OrchestrationV2GetShellSnapshotError({ message, cause }),
            ),
          );
          return { snapshotSequence, threads: threads.threads };
        },
      );

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        return yield* mutateProjectWithClone(projectService, projectCloneTracker, mutation);
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
              (command.type === "prepared-run.retry"
                ? threadLaunch.retryPreparation(command)
                : ThreadMessageIntake.dispatchCommand(
                    ThreadManagementService.withCreationProvenance(command, {
                      createdBy: "user",
                      creationSource: "creationSource" in command ? command.creationSource : "web",
                    }),
                  )
              ).pipe(
                Effect.provide(intakeContext),
                Effect.map((result) => ({ sequence: result.sequence })),
                Effect.mapError((cause) => {
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
        [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) => threadManagement.stopWorkflow(input),
        [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: (input) =>
          threadManagement.forceStopThread(input),
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
          ThreadSearch.searchThreadsWithOlderSettledRows({
            request: input,
            search: threadSearch.search,
            searchOlderSettled: threadSearch.searchOlderSettled,
            sql,
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
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
        [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input) =>
          readOmittableShellRows({ familyOf: input.threadId }, "Failed to load the thread family"),
        [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: (input) =>
          loadOlderSettledThreadsPage({
            sql,
            listThreads: threadManagement.listOlderSettledThreads(input),
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load older settled threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) =>
          readOmittableShellRows(
            { worktreePath: input.worktreePath },
            "Failed to load the worktree's threads",
          ).pipe(Effect.map(({ threads }) => ({ threadIds: threads.map((thread) => thread.id) }))),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              // Bound compatibility snapshots so pre-pagination clients cannot materialize unlimited transcripts.
              threadManagement
                .getThreadSnapshotWindow(input.threadId, {
                  rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
                })
                .pipe(
                  Effect.map(
                    (snapshot) =>
                      buildBoundedThreadProjection({
                        projection: projectThreadProjectionForWire(snapshot.projection),
                        snapshotSequence: snapshot.snapshotSequence,
                      }).projection,
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
                  ThreadManagementProviderInstanceDisabledError: (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: cause.message,
                      cause,
                    }),
                }),
              ),
            ),
          ),
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
        [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              Effect.as(commandOutputHub.subscribe(input)),
            ),
          ),
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
        [WS_METHODS.serverGetConfig]: (_input) =>
          loadServerConfig({ workspaceSnapshotsOnDemand: false }),
        // Coder: refresh workspace providers without remote manifests or unsupported usage/model refreshes.
        [WS_METHODS.serverRefreshProviders]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            // Coder: the model manifest is bundled, so a manual check only drops cached versions.
            if (input.refreshModels) {
              const instances = yield* providerInstances.listInstances;
              yield* Effect.forEach(
                instances.filter(
                  (instance) =>
                    input.instanceId === undefined || input.instanceId === instance.instanceId,
                ),
                (instance) =>
                  Effect.gen(function* () {
                    yield* instance.invalidateCaches ?? Effect.void;
                    const maintenance = yield* instance.snapshot.resolveMaintenance({
                      fresh:
                        input.instanceId !== undefined &&
                        input.cwd !== undefined &&
                        input.fresh !== true,
                    });
                    yield* Effect.forEach(
                      latestProviderVersionCacheKeys(maintenance),
                      providerLatestVersions.invalidate,
                      { discard: true },
                    );
                  }),
                { concurrency: "unbounded", discard: true },
              );
            }
            // Coder: host credentials hold no secret references (#27746), so a secret reload has
            // no host-secret cache to invalidate.
            const providers = yield* input.cwd !== undefined && input.instanceId !== undefined
              ? providerRegistry.refreshWorkspaceSnapshot({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                  fresh: input.fresh === true,
                })
              : input.reloadSecrets === true
                ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
            if (input.workspaceSnapshotsOnDemand !== true) return { providers };
            // Coder: no usage-limit commands (API usage only), so the command providers are the
            // providers themselves.
            const { instanceId, cwd } = input;
            if (instanceId === undefined || cwd === undefined) {
              return { providers: withoutWorkspaceSnapshots(providers) };
            }
            return {
              providers: providers
                .filter((provider) => provider.instanceId === instanceId)
                .map((provider) => ({
                  ...provider,
                  // Callers read only the cwd snapshot; the config stream carries the rest.
                  models: [],
                  slashCommands: [],
                  skills: [],
                  workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
                    (snapshot) => snapshot.cwd === cwd,
                  ),
                })),
            };
          }),
        [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
        [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
        [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
        [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          providerMaintenanceRunner.updateProvider(input),
        [WS_METHODS.serverUpsertKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRemoveKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
        [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
        // Coder: workspace settings have no device hosts to resolve.
        [WS_METHODS.serverUpdateSettings]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* ({ patch, providerInstanceMutation }) {
            const settings = yield* providerInstanceMutation === undefined
              ? serverSettings.updateSettings(patch)
              : serverSettings.updateProviderInstance(providerInstanceMutation, patch);
            return ServerSettings.redactServerSettingsForClient(settings);
          }),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
        [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(listAcpRegistrySessions(input))),
        [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(importAcpRegistrySession(input))),
        [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
        [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
        [WS_METHODS.pullRequestsFilterOptions]: (input) => pullRequests.filterOptions(input),
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
        [WS_METHODS.pullRequestsReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.get(input)),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.generate(input)),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          withPullRequestViewer(input, pullRequests.threadComments(input)),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          withPullRequestViewer(input, pullRequests.diffFileContents(input)),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.filesViewed(input)),
        [WS_METHODS.pullRequestsChangeBreakdown]: (input) =>
          withPullRequestViewer(input, pullRequests.changeBreakdown(input)),
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
          pullRequests
            .invalidate(input, { notifyReaders: true })
            .pipe(
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
        // Coder: no GitHub app sign-in or app access; GitLab uses the workspace's `glab` login.
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
                // The folder was empty when the project was created, so the cached
                // enrichment says "no repository" and clients cannot group it yet.
                Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
                Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
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
        [WS_METHODS.projectsCreateFromThread]: (input) =>
          scratchThreadPromotion
            .promote(input)
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
        [WS_METHODS.projectsSearchContents]: (input) =>
          workspaceEntries.searchContents(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchContentsError({
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
        // Coder: no projects.listIgnoredFiles; "Add to another machine" is not carried.
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
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
        [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
        [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
        [WS_METHODS.agentSessionsImport]: (input) =>
          agentSessionImporter.importRecentAgentThreads(input),
        [WS_METHODS.assetsCreateUrl]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            const path = yield* Path.Path;
            if (
              input.resource._tag === "attachment" ||
              input.resource._tag === "tool-output-image" ||
              input.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ||
              // A network path is served only from the thread's project, looked up below.
              (input.resource._tag === "media-file" &&
                path.isAbsolute(input.resource.path) &&
                !isNetworkPath(input.resource.path))
            ) {
              return yield* issueAssetUrl({ resource: input.resource });
            }
            if (input.resource._tag === "draft-workspace-file") {
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: input.resource.cwd,
              });
            }
            if (input.resource._tag === "project-favicon") {
              const project = yield* projectStore
                .findActiveByWorkspaceRoot(input.resource.cwd)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              // Clone projects precede their files; clients retry asset URLs after clone completion.
              const clone = yield* projectCloneTracker.get(project.value.projectId);
              return yield* issueAssetUrl({
                resource: input.resource,
                ...(project.value.faviconPath
                  ? { projectFaviconPath: project.value.faviconPath }
                  : {}),
                ...(clone !== null && clone.destinationPath === project.value.workspaceRoot
                  ? { projectCheckout: clone.phase === "done" ? "cloned" : "pending" }
                  : {}),
              });
            }
            const thread = yield* threadManagement
              .getThreadRecords(input.resource.threadId, [])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
            const project = yield* projectService.getById(thread.thread.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(project)) {
              return yield* new AssetWorkspaceContextNotFoundError({
                resource: input.resource,
              });
            }
            return yield* issueAssetUrl({
              resource: input.resource,
              workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
            });
          }),
        // Coder: no assets.persistChatAttachments; composer uploads use the signed upload URL.
        [WS_METHODS.subscribeVcsStatus]: (input) => vcsStatusBroadcaster.streamStatus(input),
        [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          worktreeSetupTracker
            .cancel(input.threadId)
            .pipe(Effect.map((cancelled) => ({ cancelled }))),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
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
        [WS_METHODS.reviewGetBranchCommits]: (input) => review.getBranchCommits(input),
        [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
        [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
        [WS_METHODS.terminalAttach]: (input, metadata) =>
          terminalManager.attachOutputStream(input, terminalViewerId(metadata)),
        [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
        [WS_METHODS.terminalResize]: (input, metadata) =>
          terminalManager.resize(input, terminalViewerId(metadata)),
        [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
        [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
        [WS_METHODS.terminalObserve]: (input) =>
          terminalOutputStream(
            (listener, registerCleanup) =>
              terminalManager.observeStream(input, listener, registerCleanup),
            (listener, registerCleanup) =>
              terminalManager.resyncStream(input, listener, registerCleanup),
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.previewStopLocalServer]: (input) => portDiscovery.stopServer(input),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          Stream.callback<DiscoveredLocalServerList>((queue) =>
            Effect.gen(function* () {
              const configuredUrls = input.configuredUrls ?? [];
              yield* portDiscovery.retain;
              const initial = yield* portDiscovery.scan(configuredUrls);
              const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
              yield* Queue.offer(queue, {
                servers: initial,
                scannedAt: initialScannedAt,
                configuredUrlProbing: true,
              });
              yield* portDiscovery.subscribe(
                { configuredUrls, initialSnapshot: initial },
                (servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, {
                      servers,
                      scannedAt,
                      configuredUrlProbing: true,
                    });
                  }),
              );
            }),
          ),
        // Coder: preserve bounded helper stdio streams and reconnect snapshots.
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Coder: API-only providers have no subscription quota sources or usage-limit commands.
              const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
              // Buffer changes through discovery and the initial snapshot's RPC ACK wait.
              const keybindingsChanges = yield* keybindings.subscribeChanges;
              const settingsChanges = yield* serverSettings.subscribeChanges;
              const config = yield* loadServerConfig({ workspaceSnapshotsOnDemand });
              const keybindingsUpdates = keybindingsChanges.pipe(
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
                // Coder: no usage-limit sources to pair with. Stripped before the de-dupe below,
                // so snapshot-only changes send nothing.
                Stream.map((providers) =>
                  workspaceSnapshotsOnDemand ? withoutWorkspaceSnapshots(providers) : providers,
                ),
                // Compare initial paired values with the snapshot; blindly dropping them loses changes between snapshot and subscription.
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
              // Gate capability-specific events; older clients reject them and lose their config subscription.
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
              const settingsUpdates = settingsChanges.pipe(
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
      // Coder: add the fork-only methods.
      const helperHandlers = CoderWsRpcGroup.of({
        ...handlers,
        ...(yield* CoderWs.makeHandlers({ serverCommandId, refreshGitStatus })),
      });
      const splitHandlers: Pick<typeof helperHandlers, SplitWsRpc["_tag"]> = helperHandlers;
      const otherHandlers: Pick<typeof helperHandlers, Exclude<ServerWsRpc, SplitWsRpc>["_tag"]> =
        helperHandlers;
      return Context.merge(
        yield* SplitWsRpcGroup.toHandlers(splitHandlers),
        yield* OtherWsRpcGroup.toHandlers(otherHandlers),
      );
    }),
  );

// Default socket-level Defect frames end every pending client request.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

// Coder: the helper stdio bridge serves this layer; there is no /ws route.
export const layer = layerWsRpc();
