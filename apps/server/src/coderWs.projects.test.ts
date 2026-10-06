import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
} from "./orchestration/Errors.ts";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Context from "effect/Context";
// Coder: verify the flat fetch interval supplied to the upstream status stream.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import {
  CoderWsRpcGroup,
  EnvironmentId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadDetailSnapshot,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThreadShell,
  type ThreadPullRequestKey,
  type PullRequestRef,
  MessageId,
  type WorktreeSetupSnapshot,
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
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
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
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
  options: {
    repository?: boolean;
    sql?: SqlClient.SqlClient;
    orchestration?: Partial<OrchestrationEngine.OrchestrationEngineShape>;
    projections?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQueryShape>;
    gitWorkflow?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
    terminals?: Partial<TerminalManager.TerminalManager["Service"]>;
    setupRunner?: Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]>;
    pullRequests?: Partial<PullRequestService.PullRequestService["Service"]>;
    pullRequestSync?: Partial<PullRequestSyncReactor["Service"]>;
    repositoryIdentity?: Partial<RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]>;
    projectClones?: Partial<ProjectCloneTracker.ProjectCloneTracker["Service"]>;
    providers?: Partial<ProviderRegistry.ProviderRegistryShape>;
    themes?: Partial<EnvironmentThemeService["Service"]>;
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    workspaceEntries?: Partial<WorkspaceEntries.WorkspaceEntries["Service"]>;
    workspaceFiles?: Partial<WorkspaceFileSystem.WorkspaceFileSystem["Service"]>;
    rejectCreate?: boolean;
    scratchRace?: boolean;
    // Coder: exercise status RPC wiring with settings and broadcaster effects stubbed.
    settings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    vcsStatus?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>;
  } = {},
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
    const dependencies = Layer.mergeAll(
      stub(EnvironmentThemeService, options.themes),
      stub(CoderEnvironment.CoderEnvironment, {
        descriptor: {
          environmentId: EnvironmentId.make("stream-test"),
          label: "Stream test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "test",
          capabilities: { repositoryIdentity: true, environmentThemes: true },
        },
      }),
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
        ...options.orchestration,
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
        ...options.projections,
      }),
      stub(CheckpointDiffQuery.CheckpointDiffQuery),
      stub(ProviderRegistry.ProviderRegistry, options.providers),
      stub(ProviderMaintenanceRunner),
      stub(ProviderInstanceRegistry.ProviderInstanceRegistry),
      stub(ProviderService),
      options.settings
        ? stub(ServerSettings.ServerSettingsService, options.settings)
        : ServerSettings.layerTest(),
      stub(Keybindings.Keybindings, options.keybindings),
      stub(WorkspaceEntries.WorkspaceEntries, options.workspaceEntries),
      stub(WorkspaceFileSystem.WorkspaceFileSystem, options.workspaceFiles),
      stub(ScreenshotArtifacts.ScreenshotArtifacts),
      stub(VcsStatusBroadcaster.VcsStatusBroadcaster, {
        refreshStatus: (cwd) =>
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
              aheadOfDefaultCount: 0,
              pr: null,
            };
          }),
        ...options.vcsStatus,
      }),
      stub(GitVcsDriver.GitVcsDriver, {
        readConfigValue: () => Effect.succeed(null),
        execute: () =>
          Effect.succeed({
            stdout: options.repository ? "true" : "",
            stderr: "",
            exitCode: ExitCode(options.repository ? 0 : 1),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
      WorktreeSetupTracker.layer,
      stub(ProjectSetupScriptRunner.ProjectSetupScriptRunner, options.setupRunner),
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
      stub(ProjectCloneTracker.ProjectCloneTracker, {
        get: () => Effect.succeed(null),
        ...options.projectClones,
      }),
      stub(PullRequestService.PullRequestService, options.pullRequests),
      stub(PullRequestSyncReactor, options.pullRequestSync),
      stub(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (cwd, resolveOptions) =>
          Effect.sync(() => {
            assert.isTrue(resolveOptions?.refresh);
            publishSteps.push(`identity:${cwd}`);
            return null;
          }),
        ...options.repositoryIdentity,
      }),
      options.sql ? Layer.succeed(SqlClient.SqlClient, options.sql) : stub(SqlClient.SqlClient),
      stub(VcsProvisioningService.VcsProvisioningService),
      stub(ReviewService.ReviewService),
      stub(TerminalManager.TerminalManager, options.terminals),
      stub(GitWorkflowService.GitWorkflowService, {
        isRepository: () => Effect.succeed(options.repository === true),
        ...options.gitWorkflow,
      }),
      ServerConfig.layer(config),
      WorkspacePaths.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const services = dependencies;
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

// Coder: the broadcaster must receive a fresh settings read, including upstream's fallback.
it.effect(
  "reads the current flat fetch interval for each status loop and falls back on failure",
  () =>
    Effect.gen(function* () {
      let settings = DEFAULT_SERVER_SETTINGS;
      let settingsFail = false;
      const intervals: number[] = [];
      const h = yield* harness({
        settings: {
          getSettings: Effect.suspend(() =>
            settingsFail
              ? Effect.fail(
                  new ServerSettingsError({
                    operation: "read-file",
                    settingsPath: "<test>",
                    cause: new Error("Unavailable test settings"),
                  }),
                )
              : Effect.succeed(settings),
          ),
        },
        vcsStatus: {
          streamStatus: (input, options) =>
            Stream.fromEffect(
              Effect.gen(function* () {
                assert.equal(input.cwd, "/repo");
                const interval = options!.automaticRemoteRefreshInterval!;
                intervals.push(Duration.toMillis(yield* interval));
                settings = { ...settings, automaticGitFetchInterval: Duration.seconds(2) };
                intervals.push(Duration.toMillis(yield* interval));
                settings = { ...settings, automaticGitFetchInterval: Duration.zero };
                intervals.push(Duration.toMillis(yield* interval));
                settingsFail = true;
                intervals.push(Duration.toMillis(yield* interval));
                return {
                  _tag: "snapshot" as const,
                  local: {
                    isRepo: false,
                    hasPrimaryRemote: false,
                    isDefaultRef: false,
                    refName: null,
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                  },
                  remote: null,
                };
              }),
            ),
        },
      });
      yield* h.client[WS_METHODS.subscribeVcsStatus]({ cwd: "/repo" }).pipe(Stream.runDrain);
      assert.deepEqual(intervals, [
        Duration.toMillis(DEFAULT_SERVER_SETTINGS.automaticGitFetchInterval),
        2000,
        0,
        Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const testThreadId = ThreadId.make("thread-rpc");
const testProjectId = ProjectId.make("project-rpc");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const threadShell = (sessionStatus: "ready" | "stopped" | null = "ready") =>
  ({
    id: testThreadId,
    projectId: testProjectId,
    worktreePath: null,
    session:
      sessionStatus === null
        ? null
        : {
            threadId: testThreadId,
            status: sessionStatus,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
  }) as OrchestrationThreadShell;

const bootstrapCommand = (projectCwd: string, requireWorktree = false) => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make("bootstrap-command"),
  threadId: testThreadId,
  message: {
    messageId: MessageId.make("bootstrap-message"),
    role: "user" as const,
    text: "Implement the change",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  bootstrap: {
    createThread: {
      projectId: testProjectId,
      title: "Bootstrap thread",
      modelSelection,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      branch: "main",
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd,
      baseBranch: "main",
      branch: "t3code/bootstrap",
      requireWorktree,
    },
    runSetupScript: true,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const worktreeResult = {
  worktree: { path: "/tmp/bootstrap-worktree", refName: "t3code/bootstrap" },
};
const setupSnapshots = (commands: OrchestrationCommand[]) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
      command.type === "thread.activity.append" && command.activity.kind === "worktree-setup",
  );

describe("upstream helper RPC behavior", () => {
  for (const stop of ["ready", "stopped", null] as const) {
    it.effect(`archives a thread with session ${stop} and closes terminals`, () =>
      Effect.gen(function* () {
        const effects: string[] = [];
        let archived = false;
        const commands: OrchestrationCommand[] = [];
        const h = yield* harness({
          projections: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:${archived ? "archived" : "active"}`);
                return archived ? Option.none() : Option.some(threadShell(stop));
              }),
          },
          orchestration: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                effects.push(command.type);
                if (command.type === "thread.archive") archived = true;
                return { sequence: commands.length };
              }),
          },
          terminals: {
            close: () =>
              Effect.sync(() => {
                effects.push("terminal.close");
              }),
          },
        });
        const result = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.archive",
          commandId: CommandId.make("archive-command"),
          threadId: testThreadId,
        });
        assert.equal(result.sequence, 1);
        assert.deepEqual(effects, [
          "query:active",
          "thread.archive",
          ...(stop === "ready" ? ["thread.session.stop"] : []),
          "terminal.close",
        ]);
        if (stop === "ready")
          assert.equal(commands[1]?.commandId, "session-stop-for-archive:archive-command");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("archives and still closes terminals when the session stop defects", () =>
    Effect.gen(function* () {
      let closed = false;
      const h = yield* harness({
        projections: { getThreadShellById: () => Effect.succeedSome(threadShell()) },
        orchestration: {
          dispatch: (command) =>
            command.type === "thread.session.stop"
              ? Effect.die(new Error("session stop failed"))
              : Effect.succeed({ sequence: 1 }),
        },
        terminals: {
          close: () =>
            Effect.sync(() => {
              closed = true;
            }),
        },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.archive",
        commandId: CommandId.make("archive-command"),
        threadId: testThreadId,
      });
      assert.equal(result.sequence, 1);
      assert.isTrue(closed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("forwards the friendly blocked-settlement message over helper RPC", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        orchestration: {
          dispatch: () =>
            Effect.fail(new OrchestrationThreadSettleBlockedError({ threadId: testThreadId })),
        },
      });
      const error = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.settle",
        commandId: CommandId.make("settle-command"),
        threadId: testThreadId,
      }).pipe(Effect.flip);
      assert.equal(
        error.message,
        "This thread still needs attention. Resolve or interrupt it first, then try again.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses server command IDs for scratch and new project creation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.client[WS_METHODS.projectsEnsureScratch]({});
      yield* h.client[WS_METHODS.projectsCreateNew]({ name: "New project" });
      assert.match(h.commands[0]!.commandId, /^server:scratch-project-create:/);
      assert.match(h.commands[1]!.commandId, /^server:scratch-project-icon:/);
      assert.match(h.commands[2]!.commandId, /^server:project-create-new:/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const reference of [
    { projectId: testProjectId, host: "code.example", repository: "team/repo", number: 42 },
    { projectId: testProjectId, repository: "team/repo", number: 42 },
  ] satisfies PullRequestRef[]) {
    it.effect(
      `routes MR actions with ${reference.host ? "explicit" : "project"} host and skips files-only invalidation sync`,
      () =>
        Effect.gen(function* () {
          const keys: ThreadPullRequestKey[] = [];
          const notifications: boolean[] = [];
          const h = yield* harness({
            projections: {
              getProjectShellById: () =>
                reference.host
                  ? Effect.die("explicit host must not look up the project")
                  : Effect.succeedSome({
                      repositoryIdentity: {
                        provider: "gitlab",
                        canonicalKey: "code.example/team/repo",
                        locator: {
                          source: "git-remote",
                          remoteName: "origin",
                          remoteUrl: "https://code.example/team/repo.git",
                        },
                      },
                    } as OrchestrationProject),
            },
            pullRequests: {
              runAction: () => Effect.succeed({}),
              invalidate: (_input, options) =>
                Effect.sync(() => {
                  notifications.push(options?.notifyReaders === true);
                }),
            },
            pullRequestSync: {
              requestSync: (key) =>
                Effect.sync(() => {
                  keys.push(key);
                }),
            },
          });
          yield* h.client[WS_METHODS.pullRequestsRunAction]({ ...reference, action: "close" });
          yield* h.client[WS_METHODS.pullRequestsInvalidate]({ reference });
          yield* h.client[WS_METHODS.pullRequestsInvalidate]({ reference, filesViewedOnly: true });
          assert.deepEqual(keys, [
            { host: "code.example", repository: "team/repo", number: 42 },
            { host: "code.example", repository: "team/repo", number: 42 },
          ]);
          assert.deepEqual(notifications, [true, true]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("returns no linked threads for a deleted project without reading MR summary", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.client[WS_METHODS.pullRequestsLinkedThreads]({
        projectId: testProjectId,
        repository: "team/repo",
        number: 42,
      });
      assert.deepEqual(result, { threads: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prepares a starting session and setup activities before handing off the turn", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const h = yield* harness({
        repository: true,
        gitWorkflow: {
          hasCommit: () => Effect.succeed(true),
          createWorktree: () =>
            Effect.sync(() => {
              calls.push("checkout");
              return worktreeResult;
            }),
        },
        vcsStatus: { refreshStatus: () => Effect.succeed({} as never) },
        setupRunner: {
          runForThread: () =>
            Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "pnpm install",
              terminalId: "setup-terminal",
              cwd: "/tmp/bootstrap-worktree",
              async: false,
              completion: Effect.succeed({ exitCode: 0, durationMs: 1 }),
            }),
        },
      });
      yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](bootstrapCommand(h.config.cwd));
      assert.deepEqual(calls, ["checkout"]);
      const preparing = h.commands.find((command) => command.type === "thread.session.set");
      assert.equal(preparing?.type, "thread.session.set");
      if (preparing?.type === "thread.session.set")
        assert.equal(preparing.session.status, "starting");
      assert.match(h.commands[0]!.commandId, /^server:bootstrap-thread-create:/);
      const activities = h.commands
        .filter((command) => command.type === "thread.activity.append")
        .map((command) => command.activity.kind);
      assert.deepEqual(activities, [
        "worktree-setup",
        "setup-script.requested",
        "setup-script.started",
        "worktree-setup",
      ]);
      assert.equal(
        (setupSnapshots(h.commands).at(-1)?.activity.payload as WorktreeSetupSnapshot).phase,
        "done",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a non-cancel bootstrap failure deletes the thread and preserves its worktree", () =>
    Effect.gen(function* () {
      let removed = false;
      const commands: OrchestrationCommand[] = [];
      const h = yield* harness({
        repository: true,
        orchestration: {
          dispatch: (command) => {
            commands.push(command);
            return command.type === "thread.turn.start"
              ? Effect.die(new Error("turn start failed"))
              : Effect.succeed({ sequence: commands.length });
          },
        },
        gitWorkflow: {
          hasCommit: () => Effect.succeed(true),
          createWorktree: () => Effect.succeed(worktreeResult),
          removeWorktree: () =>
            Effect.sync(() => {
              removed = true;
            }),
        },
        vcsStatus: { refreshStatus: () => Effect.succeed({} as never) },
        setupRunner: { runForThread: () => Effect.succeed({ status: "no-script" }) },
      });
      const error = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](
        bootstrapCommand(h.config.cwd),
      ).pipe(Effect.flip);
      assert.equal(error.message, "turn start failed");
      assert.equal(error.bootstrapThreadDisposition, "deleted");
      assert.equal(commands.at(-1)?.type, "thread.delete");
      assert.isFalse(removed);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cancel closes the setup terminal before removing the worktree and deleting the thread",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const effects: string[] = [];
        const commands: OrchestrationCommand[] = [];
        const h = yield* harness({
          repository: true,
          orchestration: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                if (command.type === "thread.delete") effects.push("thread.delete");
                return { sequence: commands.length };
              }),
          },
          gitWorkflow: {
            hasCommit: () => Effect.succeed(true),
            createWorktree: () => Effect.succeed(worktreeResult),
            removeWorktree: () =>
              Effect.sync(() => {
                effects.push("worktree.remove");
              }),
          },
          vcsStatus: { refreshStatus: () => Effect.succeed({} as never) },
          terminals: {
            close: (input) =>
              Effect.sync(() => {
                assert.equal(input.terminalId, "setup-terminal");
                assert.equal(input.deleteHistory, true);
                effects.push("terminal.close");
              }),
          },
          setupRunner: {
            runForThread: () =>
              Effect.succeed({
                status: "started",
                scriptId: "setup",
                scriptName: "Setup",
                scriptCommand: "pnpm install",
                terminalId: "setup-terminal",
                cwd: "/tmp/bootstrap-worktree",
                async: false,
                completion: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              }),
          },
        });
        const request = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](
          bootstrapCommand(h.config.cwd),
        ).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(started);
        const cancelled = yield* h.client[WS_METHODS.worktreeSetupCancel]({
          threadId: testThreadId,
        });
        assert.isTrue(cancelled.cancelled);
        const result = yield* Fiber.join(request);
        assert.equal(result._tag, "Failure");
        assert.deepEqual(effects, ["terminal.close", "worktree.remove", "thread.delete"]);
        assert.equal(
          (setupSnapshots(commands).at(-1)?.activity.payload as WorktreeSetupSnapshot).phase,
          "cancelled",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const requireWorktree of [false, true]) {
    it.effect(
      `non-repository bootstrap ${requireWorktree ? "requires a worktree" : "uses the project checkout"}`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness();
          const request = h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](
            bootstrapCommand(h.config.cwd, requireWorktree),
          );
          if (requireWorktree) {
            const error = yield* request.pipe(Effect.flip);
            assert.equal(
              error.message,
              "A separate worktree requires a Git repository and a base branch with a commit.",
            );
            assert.equal(error.bootstrapThreadDisposition, "not-created");
            assert.isFalse(h.commands.some((command) => command.type === "thread.create"));
          } else {
            yield* request;
            assert.equal(h.commands.at(-2)?.type, "thread.turn.start");
            const stages = (
              setupSnapshots(h.commands).at(-1)?.activity.payload as WorktreeSetupSnapshot
            ).stages;
            assert.deepEqual(
              stages.slice(0, 3).map(({ status, detail }) => ({ status, detail })),
              Array.from({ length: 3 }, () => ({
                status: "skipped" as const,
                detail: "using project checkout",
              })),
            );
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});

describe("Coder RPC seams", () => {
  it.effect("rejects file reads, writes, and listings for roots not owned by the thread", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        projections: { getThreadShellById: () => Effect.succeedSome(threadShell()) },
      });
      const inputs = { threadId: testThreadId, cwd: "/unowned" };
      const list = yield* h.client[WS_METHODS.projectsListEntries](inputs).pipe(Effect.flip);
      const read = yield* h.client[WS_METHODS.projectsReadFile]({
        ...inputs,
        relativePath: "file.txt",
      }).pipe(Effect.flip);
      const write = yield* h.client[WS_METHODS.projectsWriteFile]({
        ...inputs,
        relativePath: "file.txt",
        contents: "hello",
        expectedRevision: "revision",
      }).pipe(Effect.flip);
      assert.equal(list.failure, "workspace_not_owned_by_thread");
      assert.equal(read.failure, "workspace_not_owned_by_thread");
      assert.equal(write.failure, "workspace_not_owned_by_thread");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects links to hosts outside the known GitLab projects", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        projections: { getShellSnapshot: () => Effect.succeed({ projects: [] } as never) },
      });
      const error = yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.pull-request.link",
        commandId: CommandId.make("link-command"),
        threadId: testThreadId,
        host: "github.com",
        repository: "team/repo",
        number: 42,
        source: "manual",
        url: "https://github.com/team/repo/pull/42",
      }).pipe(Effect.flip);
      assert.equal(error.message, "The merge request must belong to a known GitLab host.");
      assert.equal(h.commands.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it.effect("migrates legacy project settings once and preserves resets on accepted retries", () =>
  Effect.gen(function* () {
    let accepted = false;
    const patches: unknown[] = [];
    const h = yield* harness({
      sql: (() =>
        Effect.succeed(
          accepted ? [{ command_id: "project-settings" }] : [],
        )) as unknown as SqlClient.SqlClient,
      settings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: (patch) =>
          Effect.sync(() => {
            patches.push(patch);
            return DEFAULT_SERVER_SETTINGS;
          }),
      },
    });
    const command = {
      type: "project.meta.update" as const,
      commandId: CommandId.make("project-settings"),
      projectId: testProjectId,
      autoPull: true,
    };
    yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
    accepted = true;
    yield* h.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);
    assert.deepEqual(patches, [
      { projectSettingsOverrides: { [testProjectId]: { defaultAutoPull: true } } },
    ]);
    assert.equal(h.commands.length, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "normalizes clone project creation and refreshes identity before metadata and Git status",
  () =>
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>();
      const effects: string[] = [];
      let destination = "";
      const commands: OrchestrationCommand[] = [];
      const h = yield* harness({
        orchestration: {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              effects.push(command.type);
              return { sequence: commands.length };
            }),
        },
        projectClones: {
          start: (input, hooks) =>
            Effect.gen(function* () {
              destination = input.destinationPath;
              yield* hooks.createProject({
                projectId: input.projectId,
                title: input.title,
                workspaceRoot: destination,
                createdAt: input.createdAt,
              });
              yield* hooks.onCloned({ projectId: input.projectId, workspaceRoot: destination });
              return {
                projectId: input.projectId,
                cwd: destination,
                remoteUrl: input.remoteUrl!,
                repository: null,
              };
            }),
        },
        repositoryIdentity: {
          resolve: (cwd, options) =>
            Effect.sync(() => {
              assert.equal(cwd, destination);
              assert.equal(options?.refresh, true);
              effects.push("identity");
              return null;
            }),
        },
        vcsStatus: {
          refreshStatus: () =>
            Deferred.succeed(refreshed, undefined).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  effects.push("status");
                }),
              ),
              Effect.as({} as never),
            ),
        },
      });
      const cwd = h.path.join(h.config.baseDir, "missing-clone-directory");
      yield* h.client[WS_METHODS.projectCloneStart]({
        projectId: testProjectId,
        title: "Cloned",
        destinationPath: cwd,
        remoteUrl: "https://code.example/team/repo.git",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(refreshed);
      assert.isTrue(yield* h.fs.exists(cwd));
      assert.deepEqual(effects, ["project.create", "identity", "project.meta.update", "status"]);
      assert.match(commands[0]!.commandId, /^server:project-clone-create:/);
      assert.match(commands[1]!.commandId, /^server:project-clone-done:/);
      assert.equal(commands[0]!.type, "project.create");
      if (commands[0]!.type === "project.create")
        assert.isTrue(commands[0]!.createWorkspaceRootIfMissing);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const streamThreadId = ThreadId.make("stream-thread");
const streamSnapshot: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 20,
  thread: {
    id: streamThreadId,
    projectId: ProjectId.make("stream-project"),
    title: "Stream thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "ModelA" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    pullRequests: [],
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
  },
};
function streamEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`stream-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: streamThreadId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: {
      threadId: streamThreadId,
      session: {
        threadId: streamThreadId,
        status: "idle",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}
const shellSnapshot = {
  snapshotSequence: 20,
  projects: [],
  threads: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Coder pre-v2 stream parity", () => {
  it.effect("coalesces shell replay by aggregate before the requested completion marker", () =>
    Effect.gen(function* () {
      let refetches = 0;
      const h = yield* harness({
        orchestration: {
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(3),
          readEvents: () => Stream.make(streamEvent(1), streamEvent(2), streamEvent(3)),
        },
        projections: {
          getShellSnapshot: () => Effect.die("unexpected snapshot"),
          getEventReplayStats: () => Effect.succeed({ eventCount: 3, payloadBytes: 10 }),
          getThreadShellById: () =>
            Effect.sync(() => {
              refetches++;
              return Option.none();
            }),
        },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
        afterSequence: 0,
        requestCompletionMarker: true,
      }).pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(result, [
        { kind: "thread-removed", threadId: streamThreadId, sequence: 3 },
        { kind: "synchronized" },
      ]);
      assert.strictEqual(refetches, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each(["ahead", "gap", "bytes"] as const)(
    "replaces invalid shell %s replay with a snapshot",
    (reason) =>
      Effect.gen(function* () {
        const h = yield* harness({
          orchestration: {
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(reason === "gap" ? 1001 : 20),
          },
          projections: {
            getEventReplayStats: () =>
              Effect.succeed({
                eventCount: 1,
                payloadBytes: reason === "bytes" ? 8 * 1024 * 1024 + 1 : 1,
              }),
            getShellSnapshot: () => Effect.succeed(shellSnapshot),
          },
        });
        const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
          afterSequence: reason === "ahead" ? 21 : 0,
          requestCompletionMarker: true,
        }).pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(result, [
          { kind: "snapshot", snapshot: shellSnapshot },
          { kind: "synchronized" },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("retries shell projection reads once and drops persistent failures", () =>
    Effect.gen(function* () {
      let reads = 0;
      const h = yield* harness({
        orchestration: {
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(1),
          readEvents: () => Stream.make(streamEvent(1)),
        },
        projections: {
          getShellSnapshot: () => Effect.die("unexpected snapshot"),
          getEventReplayStats: () => Effect.succeed({ eventCount: 1, payloadBytes: 1 }),
          getThreadShellById: () =>
            Effect.suspend(() => {
              reads++;
              return Effect.fail({
                _tag: "PersistenceSqlError",
                operation: "test",
                message: "busy",
              } as never);
            }),
        },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
        afterSequence: 0,
        requestCompletionMarker: true,
      }).pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(result, [{ kind: "synchronized" }]);
      assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps shell events buffered during a snapshot ahead of the completion marker", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const h = yield* harness({
        orchestration: {
          streamDomainEvents: Stream.make(streamEvent(21)).pipe(
            Stream.tap(() => Deferred.succeed(published, undefined)),
          ),
        },
        projections: {
          getShellSnapshot: () => Deferred.await(published).pipe(Effect.as(shellSnapshot)),
          getThreadShellById: () => Effect.succeedNone,
        },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
        requestCompletionMarker: true,
      }).pipe(Stream.take(3), Stream.runCollect);
      assert.deepEqual(
        result.map((item) => item.kind),
        ["snapshot", "thread-removed", "synchronized"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("counts only the requested thread when the global gap is large", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        orchestration: {
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(1_000_000),
          getThreadReplayStats: () =>
            Effect.succeed({ eventCount: 1, payloadBytes: 1, hasCreateEvent: false }),
          readThreadEvents: () => Stream.make(streamEvent(1_000_000)),
        },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: streamThreadId,
        afterSequence: 0,
        requestCompletionMarker: true,
      }).pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        result.map((item) => item.kind),
        ["event", "synchronized"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each(["ahead", "count", "bytes", "recreated"] as const)(
    "loads the bounded snapshot for thread %s replay",
    (reason) =>
      Effect.gen(function* () {
        let window: unknown;
        const h = yield* harness({
          orchestration: {
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(20),
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: reason === "count" ? 1001 : 1,
                payloadBytes: reason === "bytes" ? 8 * 1024 * 1024 + 1 : 1,
                hasCreateEvent: reason === "recreated",
              }),
            readThreadEvents: () => Stream.make(streamEvent(20)),
          },
          projections: {
            getThreadDetailSnapshot: (_id, requested) =>
              Effect.sync(() => {
                window = requested;
                return Option.some(streamSnapshot);
              }),
          },
        });
        const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
          threadId: streamThreadId,
          afterSequence: reason === "ahead" ? 21 : 0,
          turnLimit: 5,
          targetBytes: 1024,
          requestCompletionMarker: true,
        }).pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          result.map((item) => item.kind),
          ["snapshot", "synchronized"],
        );
        assert.deepEqual(window, { turnLimit: 5 });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("preserves bounded replay when a recreated thread has already disappeared", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        orchestration: {
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(20),
          getThreadReplayStats: () =>
            Effect.succeed({ eventCount: 1, payloadBytes: 1, hasCreateEvent: true }),
          readThreadEvents: () => Stream.make(streamEvent(20)),
        },
        projections: { getThreadDetailSnapshot: () => Effect.succeedNone },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: streamThreadId,
        afterSequence: 0,
        requestCompletionMarker: true,
      }).pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        result.map((item) => item.kind),
        ["event", "synchronized"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("fails a missing thread without a valid recreated replay", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        orchestration: { streamDomainEvents: Stream.empty },
        projections: { getThreadDetailSnapshot: () => Effect.succeedNone },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: streamThreadId,
      }).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(result._tag, "OrchestrationGetSnapshotError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("loads a snapshot for clients without completion-marker capability", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        orchestration: { streamDomainEvents: Stream.empty },
        projections: { getThreadDetailSnapshot: () => Effect.succeed(Option.some(streamSnapshot)) },
      });
      const result = yield* h.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: streamThreadId,
      }).pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(
        result.map((item) => item.kind),
        ["snapshot"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each([false, true])(
    "gates environment theme events (enabled: %s) without refreshing providers",
    (enabled) =>
      Effect.gen(function* () {
        const h = yield* harness({
          providers: { getProviders: Effect.succeed([]), streamChanges: Stream.empty },
          keybindings: {
            loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
            streamChanges: Stream.empty,
          },
          themes: { streamChanges: Stream.make([]) },
          settings: {
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            streamChanges: Stream.empty,
          },
        });
        const result = yield* h.client[WS_METHODS.subscribeServerConfig]({
          environmentThemes: enabled,
        }).pipe(Stream.take(enabled ? 2 : 1), Stream.runCollect);
        assert.deepEqual(
          result.map((item) => item.type),
          enabled ? ["snapshot", "environmentThemesUpdated"] : ["snapshot"],
        );
        const config = result[0];
        if (config?.type === "snapshot") {
          assert.isUndefined(config.config.environmentThemes);
          assert.isTrue(config.config.shellResumeCompletionMarker);
          assert.isTrue(config.config.threadResumeCompletionMarker);
          assert.isTrue(config.config.threadSnapshotPagination);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live("publishes complete provider arrays with snapshot deduplication and debounce", () =>
  Effect.gen(function* () {
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0",
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      skills: [],
      slashCommands: [],
    };
    const h = yield* harness({
      providers: {
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.make([provider], []),
      },
      keybindings: {
        loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
        streamChanges: Stream.empty,
      },
      settings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
      },
    });
    const result = yield* h.client[WS_METHODS.subscribeServerConfig]({}).pipe(
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepEqual(
      result.map((event) => event.type),
      ["snapshot", "providerStatuses"],
    );
    assert.deepEqual(result[1], {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
