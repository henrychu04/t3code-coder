import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as CoderBackgroundPolicy from "./coderBackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderVcsStatus from "./coderVcsStatus.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "./orchestration/Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "./orchestration/Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ScriptPtyAdapter from "./terminal/ScriptPtyAdapter.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as CoderRuntimeStartup from "./coderRuntimeStartup.ts";
import * as CoderWs from "./coderWs.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const CoderOrchestrationLayerLive = OrchestrationLayerLive.pipe(
  Layer.provideMerge(SqlitePersistenceLayerLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
);

const CoderSettingsLive = ServerSettings.layer;

const CoderProviderSessionDirectoryLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

const CoderProviderInstancesLive = ProviderInstanceRegistryHydrationLive.pipe(
  Layer.provideMerge(CoderSettingsLive),
  Layer.provideMerge(CoderBackgroundPolicy.layer),
);

const CoderProviderLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(CoderProviderSessionDirectoryLive),
  Layer.provideMerge(CoderProviderInstancesLive),
);

const CoderProviderRuntimeLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(CoderProviderLive),
  Layer.provideMerge(CoderOrchestrationLayerLive),
);

const CoderVcsDriverRegistryLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const CoderGitWorkflowLive = GitWorkflowService.layer.pipe(Layer.provide(GitVcsDriver.layer));

const CoderVcsLive = Layer.mergeAll(
  GitVcsDriver.layer,
  CoderVcsDriverRegistryLive,
  VcsProvisioningService.layer.pipe(Layer.provide(CoderVcsDriverRegistryLive)),
  CoderGitWorkflowLive,
  CoderVcsStatus.layer.pipe(Layer.provide(CoderGitWorkflowLive)),
  ReviewService.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(CoderVcsDriverRegistryLive),
  ),
);

const CoderCheckpointStoreLive = CheckpointStore.layer.pipe(
  Layer.provide(CoderVcsDriverRegistryLive),
);

const CoderCheckpointingLive = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(CoderCheckpointStoreLive),
);

const CoderTerminalLive = TerminalManager.layer.pipe(
  Layer.provideMerge(ScriptPtyAdapter.layer),
  Layer.provideMerge(ProcessRunner.layer),
);

const CoderWorkspaceEntriesLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const CoderRuntimeCoreLive = Layer.empty.pipe(
  Layer.provideMerge(SqlitePersistenceLayerLive),
  Layer.provideMerge(CoderOrchestrationLayerLive),
  Layer.provideMerge(CoderSettingsLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(CoderVcsLive),
  Layer.provideMerge(CoderCheckpointingLive),
  Layer.provideMerge(CoderTerminalLive),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(CoderWorkspaceEntriesLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(CoderEnvironment.layer),
  Layer.provideMerge(CoderProviderRuntimeLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(CoderProviderInstancesLive),
);

const CoderRuntimeFeaturesLive = Layer.mergeAll(
  ProviderRuntimeIngestionLive,
  ProviderCommandReactorLive,
  CheckpointReactorLive,
  ThreadDeletionReactorLive,
).pipe(
  Layer.provideMerge(TextGeneration.layer),
  Layer.provideMerge(RuntimeReceiptBusLive),
  Layer.provideMerge(CoderCheckpointingLive),
);

const CoderRuntimeDependenciesLive = CoderRuntimeFeaturesLive.pipe(
  Layer.provideMerge(CoderRuntimeCoreLive),
);

const CoderRuntimeStartupLive = Layer.effect(
  CoderRuntimeStartup.CoderRuntimeStartup,
  Effect.gen(function* () {
    const keybindings = yield* Keybindings.Keybindings;
    const settings = yield* ServerSettings.ServerSettingsService;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const commandGate = yield* CoderRuntimeStartup.makeCommandGate;
    const reactorScope = yield* Scope.make("sequential");

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));
    yield* keybindings.start.pipe(Effect.ignoreCause({ log: true }));
    yield* settings.start.pipe(Effect.ignoreCause({ log: true }));
    yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
    yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
    yield* CoderRuntimeStartup.autoBootstrapWorkspace;
    yield* commandGate.signalReady;

    return CoderRuntimeStartup.CoderRuntimeStartup.of({
      enqueueCommand: commandGate.enqueueCommand,
    });
  }),
);

const CoderOrchestrationReactorLive = Layer.effect(
  OrchestrationReactor.OrchestrationReactor,
  Effect.gen(function* () {
    const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
    const providerCommandReactor = yield* ProviderCommandReactor;
    const checkpointReactor = yield* CheckpointReactor;
    const threadDeletionReactor = yield* ThreadDeletionReactor;

    return OrchestrationReactor.OrchestrationReactor.of({
      start: Effect.fn("coderOrchestrationReactor.start")(function* () {
        yield* providerRuntimeIngestion.start();
        yield* providerCommandReactor.start();
        yield* checkpointReactor.start();
        yield* threadDeletionReactor.start();
      }),
    });
  }),
);

export const makeCoderRuntimeLayer = () => {
  const coderReactor = CoderOrchestrationReactorLive.pipe(
    Layer.provide(CoderRuntimeDependenciesLive),
  );
  const runtimeStartup = CoderRuntimeStartupLive.pipe(
    Layer.provideMerge(coderReactor),
    Layer.provideMerge(CoderRuntimeDependenciesLive),
  );
  const services = Layer.mergeAll(runtimeStartup, CoderRuntimeDependenciesLive).pipe(
    Layer.provideMerge(VcsProcess.layer),
  );

  return CoderWs.layer.pipe(Layer.provide(services));
};
