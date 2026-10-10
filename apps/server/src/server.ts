import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { FetchHttpClient } from "effect/http";
import * as StorageCleanup from "./storageCleanup.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Keybindings from "./keybindings.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistryLayer from "./provider/ProviderRegistry.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ProjectAutoPull from "./vcs/projectAutoPull.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ScreenshotArtifacts from "./workspace/ScreenshotArtifacts.ts";
import * as LegacyScreenshotArtifacts from "./orchestration-v2/legacy/LegacyScreenshotArtifacts.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as CoderRuntimeStartup from "./serverRuntimeStartup.ts";
import * as CoderWs from "./ws.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as T3ToolBridge from "./mcp/bridge/T3ToolBridge.ts";
import * as T3ToolDispatch from "./mcp/bridge/T3ToolDispatch.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ResourceCleanupService from "./orchestration-v2/ResourceCleanupService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";

// The secret store also holds the one-use values of agent secret requests.
const CoderSettingsLive = ServerSettings.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

// Coder: no diagnostic provider event log files, so drivers get upstream's no-op loggers.
const CoderProviderEventLoggersLive = Layer.succeed(
  ProviderEventLoggers.ProviderEventLoggers,
  ProviderEventLoggers.NoOpProviderEventLoggers,
);

// Drivers read the bundled manifest through upstream's `ModelCatalog` port.
const CoderModelCatalogLive = ModelManifest.layerModelCatalog.pipe(
  Layer.provideMerge(ModelManifest.layerBundled),
);

const CoderProviderSupportLive = Layer.mergeAll(
  CoderProviderEventLoggersLive,
  CoderModelCatalogLive,
  ProviderLatestVersions.layer,
  McpProviderSessions.layer,
);

const CoderProviderInstancesLive = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(CoderProviderSupportLive),
  // Coder: the demand-only background policy; provider update checks use fetch.
  Layer.provide(BackgroundPolicy.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(CoderSettingsLive),
  Layer.provideMerge(ScreenshotArtifacts.layer),
);

const CoderVcsDriverRegistryLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const CoderSourceControlLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(CoderVcsDriverRegistryLive),
);

const CoderTextGenerationLive = TextGeneration.layer.pipe(
  Layer.provide(CoderProviderInstancesLive),
  Layer.provide(CoderSourceControlLive),
);

const CoderSourceControlDiscoveryLive = SourceControlDiscovery.layer.pipe(
  Layer.provideMerge(CoderSourceControlLive),
);

const CoderTerminalLive = TerminalManager.layer.pipe(
  Layer.provideMerge(NodePtyAdapter.layer),
  Layer.provideMerge(ProcessRunner.layer),
);

const CoderPullRequestsLive = PullRequestService.layer.pipe(
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(PullRequestProviderRegistry.layer),
  Layer.provide(CoderSourceControlLive),
  Layer.provide(SourceControlRateLimit.layer),
);

const CoderGitManagerLive = GitManager.layer.pipe(
  // Per-project git settings resolve the acting thread's project.
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(CoderSourceControlLive),
  Layer.provideMerge(CoderTextGenerationLive),
);

const CoderGitWorkflowLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(CoderVcsDriverRegistryLive),
  Layer.provideMerge(CoderGitManagerLive),
);

const CoderSourceControlRepositoriesLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(CoderSourceControlLive),
);

const CoderVcsLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(CoderVcsDriverRegistryLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(CoderVcsDriverRegistryLive))),
  Layer.provideMerge(CoderGitWorkflowLive),
  Layer.provideMerge(
    ReviewService.layer.pipe(
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(CoderVcsDriverRegistryLive),
    ),
  ),
  Layer.provideMerge(CoderSourceControlRepositoriesLive),
  Layer.provideMerge(
    ProjectCloneTracker.layer.pipe(Layer.provide(CoderSourceControlRepositoriesLive)),
  ),
  // Coder: provide the demand-only background policy and fork settings resolution.
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(CoderGitWorkflowLive),
      Layer.provide(BackgroundPolicy.layer),
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

const CoderCheckpointStoreLive = CheckpointStore.layer.pipe(
  Layer.provide(CoderVcsDriverRegistryLive),
);

// Coder: thread deletion closes terminals but never deletes attachments.
const CoderResourceCleanupLive = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    return {
      cleanupTerminals: (threadId: string) =>
        terminals.close({ threadId, deleteHistory: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ResourceCleanupService.ResourceCleanupError({
                operation: "terminal",
                threadId,
                cause,
              }),
          ),
        ),
      // Coder: there is no browser preview.
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: () => Effect.void,
    };
  }),
);

// Coder: no provider turn analytics are recorded (`ProviderTurnAnalytics` keeps its no-op default).
const CoderOrchestrationRuntimeLive = RuntimeLayer.layerProduction.pipe(
  Layer.provide(CoderCheckpointStoreLive),
  Layer.provide(CoderGitWorkflowLive),
  Layer.provide(CoderResourceCleanupLive),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(CoderPullRequestsLive),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const CoderOrchestrationApplicationLive = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(CoderCheckpointStoreLive),
  Layer.provideMerge(CoderOrchestrationRuntimeLive),
);

// Automatic thread settlement: a server-owned sweep evaluates inactivity and
// merged pull requests, then settles through the orchestrator.
const ThreadSettlementWorkerLive = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(CoderPullRequestsLive), Layer.provide(ProjectionStoreV2.layer));

const ThreadPullRequestWorkerLive = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(CoderPullRequestsLive));

const PullRequestSyncWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
    yield* service.start();
  }),
).pipe(
  Layer.provideMerge(PullRequestSyncReactor.layer),
  Layer.provide(CoderPullRequestsLive),
  Layer.provide(ProjectionStoreV2.layer),
);

// Agents watching a merge request are woken when its checks, reviews, or conflicts need them.
const PullRequestWatchWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
    yield* service.start();
  }),
).pipe(
  Layer.provide(PullRequestWatchReactor.layer),
  Layer.provide(CoderPullRequestsLive),
  Layer.provide(ProjectionStoreV2.layer),
);

const CoderWorkspaceEntriesLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const CoderWorkspaceFileSystemLive = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(CoderWorkspaceEntriesLive),
);

const CoderRuntimeCoreLive = Layer.mergeAll(
  ThreadSettlementWorkerLive,
  ThreadPullRequestWorkerLive,
  PullRequestSyncWorkerLive,
  PullRequestWatchWorkerLive,
  CoderPullRequestsLive,
).pipe(
  Layer.provideMerge(CoderOrchestrationApplicationLive),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(CoderSettingsLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(CoderVcsLive),
  Layer.provideMerge(CoderSourceControlDiscoveryLive),
  Layer.provideMerge(CoderTerminalLive),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(CoderWorkspaceEntriesLive),
  Layer.provideMerge(CoderWorkspaceFileSystemLive),
);

const CoderRuntimeDependenciesLive = CoderRuntimeCoreLive.pipe(
  Layer.provideMerge(ScreenshotArtifacts.layer),
  Layer.provideMerge(LegacyScreenshotArtifacts.layer),
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(Layer.provide(ProjectFaviconResolver.layer)),
  ),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(CoderEnvironment.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  // Coder: credentials are workspace file bridges that carry upstream's T3 toolkits.
  Layer.provideMerge(McpSessionRegistry.layer.pipe(Layer.provide(CoderEnvironment.layer))),
  Layer.provideMerge(T3ToolDispatch.layer),
  Layer.provideMerge(CoderProviderSupportLive),
  Layer.provideMerge(
    ProviderMaintenanceRunner.layer.pipe(
      Layer.provide(CoderProviderSupportLive),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ProviderRegistryLayer.layer),
    ),
  ),
  Layer.provideMerge(ProviderRegistryLayer.layer),
  Layer.provideMerge(CoderProviderInstancesLive),
  Layer.provideMerge(ModelManifest.layerBundled),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

// Coder: workspace startup completes before the RPC layer is built, replacing upstream's
// startup command queue and its HTTP listener, browser, relay, and heartbeat phases.
const CoderRuntimeStartupLive = Layer.effect(
  CoderRuntimeStartup.CoderRuntimeStartup,
  Effect.gen(function* () {
    const keybindings = yield* Keybindings.Keybindings;
    const settings = yield* ServerSettings.ServerSettingsService;
    const legacyV1ThreadImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const providerRuntimeRecovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const gitLabCli = yield* GitLabCli.GitLabCli;
    const config = yield* ServerConfig.ServerConfig;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const t3Tools = yield* T3ToolDispatch.T3ToolDispatch;
    const runtimeScope = yield* Scope.make("sequential");
    const effectWorkerContext =
      yield* Effect.context<Effect.Services<typeof EffectWorker.runDaemon>>();

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Scope.close(runtimeScope, Exit.void);
        yield* providerRuntimeRecovery.prepareForShutdown.pipe(
          Effect.ensuring(providerSessions.shutdown),
        );
        yield* providerRuntimeRecovery.reconcile("shutdown");
      }).pipe(Effect.ignoreCause({ log: true })),
    );
    yield* keybindings.start.pipe(Effect.ignoreCause({ log: true }));
    yield* settings.start.pipe(Effect.ignoreCause({ log: true }));

    const legacyMigrationThreadCount = yield* legacyV1ThreadImporter.pendingThreadCount;
    if (legacyMigrationThreadCount > 0) {
      yield* lifecycleEvents.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: "running", totalThreadCount: legacyMigrationThreadCount },
      });
    }
    yield* legacyV1ThreadImporter.reconcileShells;
    // Coder: bind agents' T3 tools before recovery or the effect worker can open a session.
    yield* t3Tools.bind(
      yield* T3ToolBridge.makeBinding.pipe(
        // As upstream provides its MCP server's toolkits.
        Effect.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
        Scope.provide(runtimeScope),
      ),
    );
    yield* providerRuntimeRecovery.recover;
    const effectWorker: Fiber.Fiber<void, never> = yield* EffectWorker.runDaemon.pipe(
      Effect.provide(effectWorkerContext),
      Effect.forkIn(runtimeScope),
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(effectWorker).pipe(Effect.ignore));
    yield* projectStore.listShells().pipe(
      Effect.flatMap((projects) =>
        settings.getSettings.pipe(
          Effect.flatMap((value) => ProjectAutoPull.autoPullProjects(projects, value)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load projects for automatic pull", { cause }),
      ),
    );
    yield* legacyV1ThreadImporter.importPendingTranscripts.pipe(
      Effect.andThen(
        legacyMigrationThreadCount > 0
          ? lifecycleEvents.publish({
              version: 1,
              type: "legacyThreadMigration",
              payload: { status: "complete", totalThreadCount: legacyMigrationThreadCount },
            })
          : Effect.void,
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(runtimeScope),
    );
    yield* Effect.forkScoped(gitLabCli.probeWriteAccess({ cwd: config.cwd }).pipe(Effect.asVoid));

    return CoderRuntimeStartup.CoderRuntimeStartup.of({});
  }),
);

export const makeCoderRuntimeLayer = () => {
  const runtimeStartup = CoderRuntimeStartupLive.pipe(
    Layer.provideMerge(CoderRuntimeDependenciesLive),
  );
  // Coder: storage cleanup starts once workspace startup completes, where upstream parks it
  // until server activation.
  const startedRuntime = StorageCleanup.layer.pipe(
    Layer.provide(ProjectionStoreV2.layer),
    Layer.provideMerge(runtimeStartup),
  );
  const services = Layer.mergeAll(
    startedRuntime,
    CoderRuntimeDependenciesLive,
    EnvironmentTheme.layer,
  ).pipe(
    Layer.provideMerge(VcsProcess.layer),
    // Every agent and terminal spawn reads this, so it sits below everything.
    Layer.provideMerge(AgentScopeLive.layer),
  );
  // Upstream provides the agent-session scanner beside its WS layer; the helper RPC layer
  // takes it here.
  const rpcServices = AgentSessionScanner.layer.pipe(Layer.provideMerge(services));

  return CoderWs.layer.pipe(Layer.provide(rpcServices));
};
