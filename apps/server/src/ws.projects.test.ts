import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { assert, describe, it } from "@effect/vitest";
import {
  CoderWsRpcGroup,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "./processRunner.ts";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as BuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderRuntimeStartup from "./serverRuntimeStartup.ts";
import * as CoderWs from "./ws.ts";
import { EnvironmentThemeService } from "./environmentTheme.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import { ProviderMaintenanceRunner } from "./provider/providerMaintenanceRunner.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

// Unused services fail loudly if an RPC starts depending on them.
function stub<I, S extends object>(key: Context.Key<I, S>, overrides: Partial<S> = {}) {
  return Layer.succeed(
    key,
    new Proxy(overrides as S, {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        throw new Error(`Unexpected dependency: ${key.key}.${String(property)}`);
      },
    }),
  );
}

const testThreadId = ThreadId.make("thread-rpc");
const testProjectId = ProjectId.make("project-rpc");
const project = {
  id: testProjectId,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: {
    provider: SourceControlProviderKind.make("gitlab"),
    canonicalKey: "code.example/team/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://code.example/team/repo.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as OrchestrationProjectShell;
const threadShell = {
  id: testThreadId,
  projectId: testProjectId,
  worktreePath: null,
  lineage: { relationshipToParent: null },
} as unknown as OrchestrationV2ThreadShell;

const harness = (
  options: {
    readonly threadManagement?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
    readonly lifecycle?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest("/", { prefix: "t3-coder-ws-rpc-" })),
    );
    const publishSteps: string[] = [];
    const dependencies = Layer.mergeAll(
      stub(EnvironmentThemeService),
      stub(CoderEnvironment.CoderEnvironment, {
        descriptor: {
          environmentId: EnvironmentId.make("ws-test"),
          label: "WS test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "test",
          capabilities: { repositoryIdentity: true, environmentThemes: true },
        },
      }),
      stub(CoderRuntimeStartup.CoderRuntimeStartup),
      stub(ThreadManagementService.ThreadManagementService, {
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === testThreadId ? threadShell : null),
        getShellSnapshot: () => Effect.succeed({ threads: [threadShell] } as never),
        ...options.threadManagement,
      }),
      stub(ThreadLaunchService.ThreadLaunchService),
      stub(OrchestrationEventStore.OrchestrationEventStore),
      stub(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([project]),
        findActiveByWorkspaceRoot: () => Effect.succeedNone,
      }),
      stub(ProjectService.ProjectService, {
        getShell: (id) =>
          Effect.succeed(id === testProjectId ? Option.some(project) : Option.none()),
      }),
      stub(ManagedProjectFolders.ManagedProjectFolders),
      stub(ScratchThreadPromotion.ScratchThreadPromotion),
      stub(ThreadSearch.ThreadSearch),
      stub(ProviderSessionManager.ProviderSessionManagerV2),
      stub(ScheduledTasks.ScheduledTaskService),
      stub(Orchestrator.OrchestratorV2),
      stub(AgentSessionScanner.AgentSessionScanner),
      stub(AgentSessionImporter.AgentSessionImporter),
      stub(ServerLifecycleEvents.ServerLifecycleEvents, {
        snapshot: Effect.succeed({ sequence: 0, events: [] }),
        stream: Stream.never,
        ...options.lifecycle,
      }),
      stub(ProjectEnrichmentService.ProjectEnrichmentService),
      stub(CheckpointDiffQuery.CheckpointDiffQuery),
      stub(ProviderRegistry.ProviderRegistry),
      stub(ProviderMaintenanceRunner),
      stub(ProviderInstanceRegistry.ProviderInstanceRegistry),
      stub(ProviderLatestVersions.ProviderLatestVersions),
      ServerSettings.layerTest(),
      stub(Keybindings.Keybindings),
      stub(WorkspaceEntries.WorkspaceEntries),
      stub(WorkspaceFileSystem.WorkspaceFileSystem),
      stub(VcsStatusBroadcaster.VcsStatusBroadcaster, {
        refreshStatus: (cwd) =>
          Effect.sync(() => {
            publishSteps.push(`status:${cwd}`);
            return {} as never;
          }),
      }),
      WorktreeSetupTracker.layer,
      stub(SourceControlDiscovery.SourceControlDiscovery),
      stub(SourceControlRepositoryService.SourceControlRepositoryService, {
        publishRepository: (input) =>
          Effect.sync(() => {
            publishSteps.push(`publish:${input.cwd}`);
            return {
              repository: {
                provider: SourceControlProviderKind.make("gitlab"),
                nameWithOwner: input.repository,
                url: "https://gitlab.example.test/owner/repository",
                sshUrl: "git@gitlab.example.test:owner/repository.git",
              },
              remoteName: "origin",
              remoteUrl: "git@gitlab.example.test:owner/repository.git",
              branch: "main",
              status: "pushed" as const,
            };
          }),
      }),
      stub(GitLabCli.GitLabCli),
      stub(ProjectCloneTracker.ProjectCloneTracker),
      stub(PullRequestService.PullRequestService),
      stub(PullRequestReviewGuideService.PullRequestReviewGuideService),
      stub(PullRequestSyncReactor.PullRequestSyncReactor),
      stub(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (cwd, resolveOptions) =>
          Effect.sync(() => {
            assert.isTrue(resolveOptions?.refresh);
            publishSteps.push(`identity:${cwd}`);
            return null;
          }),
      }),
      stub(SqlClient.SqlClient, {
        withTransaction: (effect) => effect,
      } as Partial<SqlClient.SqlClient>),
      stub(VcsProvisioningService.VcsProvisioningService),
      stub(ReviewService.ReviewService),
      stub(TerminalManager.TerminalManager),
      stub(GitWorkflowService.GitWorkflowService),
      stub(SecretRequests.SecretRequests),
      stub(McpAppRequests.McpAppRequests),
      stub(StorageCleanup.StorageCleanup),
      stub(CommandOutputHub.CommandOutputHub),
      stub(ServerSecretStore.ServerSecretStore),
      stub(ProjectFaviconResolver.ProjectFaviconResolver),
      stub(DocumentText.DocumentText),
      stub(ProcessRunner.ProcessRunner),
      Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
      ServerConfig.layer(config),
      WorkspacePaths.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const client = yield* RpcTest.makeClient(CoderWsRpcGroup).pipe(
      Effect.provide(CoderWs.layer.pipe(Layer.provide(dependencies))),
    );
    return { client, publishSteps };
  });

describe("Coder RPC seams", () => {
  it.effect("refreshes repository identity after publishing and before VCS status", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.client[WS_METHODS.sourceControlPublishRepository]({
        cwd: "/workspace/project",
        provider: SourceControlProviderKind.make("gitlab"),
        repository: "owner/repository",
        visibility: "private",
      });
      assert.equal(result.status, "pushed");
      // The status refresh is detached, as in upstream ws.ts; wait for it to run.
      for (let attempt = 0; attempt < 100 && h.publishSteps.length < 3; attempt++) {
        yield* Effect.yieldNow;
      }
      assert.deepEqual(h.publishSteps, [
        "publish:/workspace/project",
        "identity:/workspace/project",
        "status:/workspace/project",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads a thread transcript with the workspace identity and reports its size limit",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          threadManagement: {
            getThreadTranscript: (threadId) =>
              Effect.gen(function* () {
                const identity = yield* CoderEnvironment.ServerEnvironmentIdentity;
                assert.equal(yield* identity.getEnvironmentId, EnvironmentId.make("ws-test"));
                if (threadId !== testThreadId) {
                  return yield* new ThreadManagementService.ThreadTranscriptTooLargeError({
                    threadId,
                  });
                }
                return {
                  threadId,
                  title: "Thread",
                  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  items: [],
                };
              }),
          },
        });
        const transcript = yield* h.client[WS_METHODS.orchestrationGetThreadTranscript]({
          threadId: testThreadId,
        });
        assert.equal(transcript.title, "Thread");
        const error = yield* h.client[WS_METHODS.orchestrationGetThreadTranscript]({
          threadId: ThreadId.make("thread-too-large"),
        }).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestrationThreadTranscriptTooLargeError");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("synthesizes welcome and ready before legacy thread migration progress", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        lifecycle: {
          snapshot: Effect.succeed({
            sequence: 1,
            events: [
              {
                version: 1,
                sequence: 1,
                type: "legacyThreadMigration",
                payload: { status: "running", totalThreadCount: 3 },
              },
            ],
          }),
        },
      });
      const events = yield* h.client[WS_METHODS.subscribeServerLifecycle]({}).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
      assert.deepEqual(
        Array.from(events).map((event) => [event.sequence, event.type]),
        [
          [1, "welcome"],
          [2, "ready"],
          [3, "legacyThreadMigration"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
