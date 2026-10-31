// Coder: the helper's runtime layer. It composes the layers `server.ts` carries from upstream with
// the Coder provider, orchestration, startup, and RPC wiring that replace upstream's HTTP server.
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { FetchHttpClient } from "effect/http";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EventStoreV2 from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as Keybindings from "./keybindings.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderRegistryLayer from "./provider/ProviderRegistry.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ProjectAutoPull from "./vcs/projectAutoPull.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
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
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as CoderHub from "./coderHub.ts";
import * as PeerForwarding from "./peer/PeerForwarding.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import * as RemoteDelegation from "./peer/RemoteDelegation.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import {
  layerCheckpointStore,
  layerGitWorkflow,
  layerIdleCompactionWorker,
  layerPullRequestService,
  layerRepositoryIdentityResolver,
  layerServerSettings,
  layerSourceControlProviderRegistry,
  layerTerminal,
  layerThreadPullRequestWorker,
  layerThreadSettlementWorker,
  layerVcs,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
} from "./server.ts";

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
  Layer.provideMerge(layerServerSettings),
);

// The registry reads provider latest versions to settle update state (#18723).
const CoderProviderRegistryLive = ProviderRegistryLayer.layer.pipe(
  Layer.provide(CoderProviderSupportLive),
);

const CoderSourceControlDiscoveryLive = SourceControlDiscovery.layer.pipe(
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

// Coder: no provider turn analytics are recorded (`ProviderTurnAnalytics` keeps its no-op default).
const CoderOrchestrationRuntimeLive = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const CoderOrchestrationApplicationLive = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(CoderOrchestrationRuntimeLive),
);

const PullRequestSyncWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
    yield* service.start();
  }),
).pipe(
  Layer.provideMerge(PullRequestSyncReactor.layer),
  Layer.provide(layerPullRequestService),
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
  Layer.provide(layerPullRequestService),
  Layer.provide(ProjectionStoreV2.layer),
);

// A delegated task's question wakes its parent agent, as upstream.
const DelegatedTaskQuestionWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    yield* service.start();
  }),
).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer));

// Review guides read through the same merge-request service as every other surface, and are
// shared by the RPC handlers and the T3 tools.
const PullRequestReviewGuideLive = PullRequestReviewGuideService.layer.pipe(
  Layer.provide(PullRequestReviewGuides.layer),
  Layer.provide(layerPullRequestService),
);

// Coder: upstream's linked-environment forwarding and delegated tasks, over the gateway hub
// instead of HTTP `/mcp` (`coderHub.ts`, `peer/PeerMcpClient.ts`, `peer/PeerLinks.ts`).
const CoderLinkedWorkspacesLive = RemoteDelegation.layer.pipe(
  Layer.provide(ProjectionStoreV2.layer),
  Layer.provideMerge(PeerForwarding.layer),
  Layer.provideMerge(PeerMcpClient.layer),
  Layer.provideMerge(PeerLinks.layer),
  Layer.provideMerge(CoderHub.layer),
);

const CoderRuntimeCoreLive = Layer.mergeAll(
  layerThreadSettlementWorker,
  layerIdleCompactionWorker,
  layerThreadPullRequestWorker,
  PullRequestSyncWorkerLive,
  PullRequestWatchWorkerLive,
  DelegatedTaskQuestionWorkerLive,
  layerPullRequestService,
  PullRequestReviewGuideLive,
  CoderLinkedWorkspacesLive,
  // As upstream: catches project provider overrides left behind by a project deleted before
  // ProjectService.delete cleared them, or by a cleanup write that failed.
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
).pipe(
  Layer.provideMerge(CoderOrchestrationApplicationLive),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(layerServerSettings),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(CoderSourceControlDiscoveryLive),
  Layer.provideMerge(layerTerminal),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(layerWorkspaceEntries),
  Layer.provideMerge(layerWorkspaceFileSystem),
);

const CoderRuntimeDependenciesLive = CoderRuntimeCoreLive.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  // As upstream: the asset route and project enrichment share one favicon resolver.
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  // As upstream: hosts refine an identity no remote parser recognised (GitLab confirms a
  // self-hosted host through its `glab` login).
  Layer.provideMerge(layerRepositoryIdentityResolver),
  // As upstream's `layerBackground`: periodic merge request discovery asks the (always-allow)
  // background policy before each sweep.
  Layer.provideMerge(BackgroundPolicy.layer),
  // Linked-workspace forwarding and the hub name this workspace by upstream's identity service,
  // which this layer also provides.
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
      Layer.provide(CoderProviderRegistryLive),
    ),
  ),
  Layer.provideMerge(CoderProviderRegistryLive),
  Layer.provideMerge(CoderProviderInstancesLive),
  // Coder: the RPC layer serializes Kilo Code native session imports through the ACP Registry
  // runtime coordinator. Upstream provides it with the registry catalog
  // (`AcpRegistrySupport.layerFromHost`), which the RPC layer does not use.
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(ModelManifest.layerBundled),
  Layer.provideMerge(SqlitePersistenceLayerLive),
  // As upstream's runtime: every source control driver is built with an HTTP client, though
  // GitLab's reads go through `glab`.
  Layer.provideMerge(FetchHttpClient.layer),
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
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const t3Tools = yield* T3ToolDispatch.T3ToolDispatch;
    const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;
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
    // Settles delegated tasks whose runs recovery just terminalized, as upstream's startup does.
    yield* orchestrator.recoverDelegatedTasks;
    // Follows delegated tasks running in linked workspaces, including after a restart, as
    // upstream's routes layer does.
    yield* remoteDelegation.start().pipe(Scope.provide(runtimeScope));
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

    return CoderRuntimeStartup.CoderRuntimeStartup.of({});
  }),
);

export const makeCoderRuntimeLayer = () => {
  const runtimeStartup = CoderRuntimeStartupLive.pipe(
    Layer.provideMerge(CoderRuntimeDependenciesLive),
  );
  // Coder: storage cleanup starts once workspace startup completes, where upstream parks it
  // until server activation.
  const startedRuntime = Layer.mergeAll(
    StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
    // Background history compaction and space reclaim, as upstream (see DatabaseStorage.ts).
    DatabaseStorage.layer.pipe(
      Layer.provide(ProjectionMaintenance.layer),
      Layer.provide(
        Layer.merge(EventStoreV2.layerFromOrchestrationEventStore, ProjectionStoreV2.layer),
      ),
    ),
  ).pipe(Layer.provideMerge(runtimeStartup));
  const services = Layer.mergeAll(
    startedRuntime,
    CoderRuntimeDependenciesLive,
    EnvironmentTheme.layer,
  ).pipe(
    Layer.provideMerge(VcsProcess.layer),
    // Every agent and terminal spawn reads this, so it sits below everything.
    Layer.provideMerge(AgentScopeLive.layer),
    // As upstream's platform services: attachment uploads, agent attachments, and the project
    // toolkit read office documents' extracted text.
    Layer.provideMerge(DocumentText.layer),
  );
  // Upstream provides the agent-session scanner beside its WS layer; the helper RPC layer
  // takes it here.
  const rpcServices = AgentSessionScanner.layer.pipe(Layer.provideMerge(services));

  // Coder: the gateway hub methods (helper protocol v3) share the runtime's CoderHub.
  return Layer.mergeAll(CoderWs.layer, CoderHub.handlersLayer).pipe(Layer.provide(rpcServices));
};
