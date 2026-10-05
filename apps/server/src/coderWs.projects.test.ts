import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import {
  CoderWsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  CommandId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProject,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as CoderWs from "./coderWs.ts";
import { EnvironmentThemeService } from "./environmentTheme.ts";
import * as CoderEnvironment from "./coderEnvironment.ts";
import * as CoderRuntimeStartup from "./coderRuntimeStartup.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import { ProviderMaintenanceRunner } from "./provider/providerMaintenanceRunner.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as Keybindings from "./keybindings.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as ScreenshotArtifacts from "./workspace/ScreenshotArtifacts.ts";
import * as CoderVcsStatus from "./coderVcsStatus.ts";
import { RepositoryIdentityResolver } from "./project/RepositoryIdentityResolver.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { PullRequestSyncReactor } from "./orchestration/PullRequestSyncReactor.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as TerminalManager from "./terminal/Manager.ts";

// Unused services fail loudly if a project RPC starts depending on them.
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

const harness = (
  options: { repository?: boolean; rejectCreate?: boolean; scratchRace?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest("/", { prefix: "t3-coder-project-rpc-" })),
    );
    const commands: OrchestrationCommand[] = [];
    const publishSteps: string[] = [];
    const projects = new Map<ProjectId, OrchestrationProject>();
    const services = Layer.mergeAll(
      stub(EnvironmentThemeService),
      stub(CoderEnvironment.CoderEnvironment),
      stub(CoderRuntimeStartup.CoderRuntimeStartup),
      stub(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command) =>
          Effect.gen(function* () {
            if (
              command.type === "project.create" &&
              (options.rejectCreate || options.scratchRace)
            ) {
              if (options.scratchRace)
                projects.set(ProjectId.make("race-winner"), {
                  id: ProjectId.make("race-winner"),
                  title: "No project",
                  workspaceRoot: command.workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  deletedAt: null,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                });
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Active project already exists for workspace root.",
              });
            }
            commands.push(command);
            if (command.type === "project.create")
              projects.set(command.projectId, {
                id: command.projectId,
                title: command.title,
                workspaceRoot: command.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                deletedAt: null,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              });
            return { sequence: commands.length };
          }),
      }),
      stub(ThreadDeletionReactor, { drainThrough: () => Effect.void }),
      stub(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
        getActiveProjectByWorkspaceRoot: (root) =>
          Effect.sync(() =>
            Option.fromNullishOr(
              [...projects.values()].find((project) => project.workspaceRoot === root),
            ),
          ),
      }),
      stub(CheckpointDiffQuery.CheckpointDiffQuery),
      stub(ProviderRegistry.ProviderRegistry),
      stub(ProviderMaintenanceRunner),
      stub(ProviderInstanceRegistry.ProviderInstanceRegistry),
      stub(ProviderService),
      ServerSettings.layerTest(),
      stub(Keybindings.Keybindings),
      stub(WorkspaceEntries.WorkspaceEntries),
      stub(WorkspaceFileSystem.WorkspaceFileSystem),
      stub(ScreenshotArtifacts.ScreenshotArtifacts),
      stub(CoderVcsStatus.CoderVcsStatus, {
        refresh: (cwd) =>
          Effect.sync(() => {
            publishSteps.push(`status:${cwd}`);
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: true,
              aheadCount: 0,
              behindCount: 0,
              pr: null,
            };
          }),
      }),
      stub(RepositoryIdentityResolver, {
        resolve: (cwd, options) =>
          Effect.sync(() => {
            assert.isTrue(options?.refresh);
            publishSteps.push(`identity:${cwd}`);
            return null;
          }),
      }),
      stub(GitWorkflowService.GitWorkflowService),
      stub(GitVcsDriver.GitVcsDriver, {
        execute: () =>
          Effect.succeed({
            stdout: options.repository ? "true" : "",
            stderr: "",
            exitCode: ExitCode(options.repository ? 0 : 1),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
      stub(WorktreeSetupTracker.WorktreeSetupTracker),
      stub(ProjectSetupScriptRunner.ProjectSetupScriptRunner),
      stub(SourceControlDiscovery.SourceControlDiscovery),
      stub(SourceControlRepositoryService.SourceControlRepositoryService, {
        publishRepository: (input) =>
          Effect.sync(() => {
            publishSteps.push(`publish:${input.cwd}`);
            return {
              repository: {
                provider: "gitlab" as const,
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
      stub(ProjectCloneTracker.ProjectCloneTracker, { get: () => Effect.succeed(null) }),
      stub(PullRequestService.PullRequestService),
      stub(PullRequestSyncReactor),
      stub(SqlClient.SqlClient),
      stub(VcsProvisioningService.VcsProvisioningService),
      stub(ReviewService.ReviewService),
      stub(TerminalManager.TerminalManager),
      ServerConfig.layer(config),
      WorkspacePaths.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const client = yield* RpcTest.makeClient(CoderWsRpcGroup).pipe(
      Effect.provide(CoderWs.layer.pipe(Layer.provide(services))),
    );
    return { fs, path, config, commands, projects, client, publishSteps };
  });

describe("Coder project RPCs", () => {
  it.effect("refreshes repository identity after publishing and before VCS status", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.client[WS_METHODS.sourceControlPublishRepository]({
        cwd: "/workspace/project",
        provider: "gitlab",
        repository: "owner/repository",
        visibility: "private",
      });
      assert.equal(result.status, "pushed");
      assert.deepEqual(h.publishSteps, [
        "publish:/workspace/project",
        "identity:/workspace/project",
        "status:/workspace/project",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates scratch once and restores its deleted folder on reuse", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const ensure = h.client[WS_METHODS.projectsEnsureScratch];
      const first = yield* ensure({});
      const root = h.path.join(h.config.baseDir, "scratch");
      yield* h.fs.remove(root, { recursive: true });
      const second = yield* ensure({});
      assert.equal(second.projectId, first.projectId);
      assert.equal(h.commands.filter((command) => command.type === "project.create").length, 1);
      assert.isTrue(yield* h.fs.exists(root));
      assert.deepEqual(
        h.commands
          .filter((command) => command.type === "project.meta.update")
          .map((command) => command.projectIcon),
        [{ kind: "lucide", name: "message-square-dashed", color: "gray" }],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("contains named thread folders and claims collision fallbacks", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const ensure = h.client[WS_METHODS.projectsEnsureScratch];
      const { projectId } = yield* ensure({});
      const dispatch = h.client[ORCHESTRATION_WS_METHODS.dispatchCommand];
      for (const [index, id] of [
        "a1b2c3d4-first",
        "a1b2c3d4-second",
        "../../escape",
        "f00dcafe-long",
      ].entries()) {
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${index}`),
          threadId: ThreadId.make(id),
          projectId,
          title: index === 3 ? "x".repeat(300) : "../../Convert these PNGs to WebP, please!",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-09-25T10:00:00.000Z",
        });
      }
      const folders = h.commands
        .filter((command) => command.type === "thread.create")
        .map((command) => command.worktreePath!);
      assert.equal(new Set(folders).size, 4);
      for (const folder of folders) {
        assert.equal(h.path.dirname(folder), h.path.join(h.config.baseDir, "scratch"));
        assert.isBelow(h.path.basename(folder).length, 100);
        assert.isTrue(yield* h.fs.exists(folder));
      }
      assert.match(folders[0]!, /convert-these-pngs-to-webp-a1b2c3d4$/);
      assert.match(folders[1]!, /a1b2c3d4second$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates projects by name beneath the configured root with collision suffixes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const create = h.client[WS_METHODS.projectsCreateNew];
      const first = yield* create({ name: "../../My Project" });
      const second = yield* create({ name: "My Project" });
      assert.equal(first.workspaceRoot, h.path.join(h.config.baseDir, "projects", "my-project"));
      assert.equal(second.workspaceRoot, `${first.workspaceRoot}-2`);
      assert.isTrue(yield* h.fs.exists(h.path.join(first.workspaceRoot, "README.md")));
      assert.isTrue(h.projects.has(first.projectId));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("resolves a lost scratch create race to the winning project", () =>
    Effect.gen(function* () {
      const h = yield* harness({ scratchRace: true });
      const result = yield* h.client[WS_METHODS.projectsEnsureScratch]({});
      assert.equal(result.projectId, ProjectId.make("race-winner"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("disables scratch for repository-backed helper state", () =>
    Effect.gen(function* () {
      const h = yield* harness({ repository: true });
      const error = yield* h.client[WS_METHODS.projectsEnsureScratch]({}).pipe(Effect.flip);
      assert.include(error.message, "not available");
      assert.equal(h.commands.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a newly claimed project folder after a rejected create", () =>
    Effect.gen(function* () {
      const h = yield* harness({ rejectCreate: true });
      yield* h.client[WS_METHODS.projectsCreateNew]({ name: "Rejected" }).pipe(Effect.flip);
      assert.isFalse(yield* h.fs.exists(h.path.join(h.config.baseDir, "projects", "rejected")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
