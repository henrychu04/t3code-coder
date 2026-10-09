import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CoderEnvironment from "../../coderEnvironment.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import * as T3ToolBridge from "./T3ToolBridge.ts";
import * as T3ToolDispatch from "./T3ToolDispatch.ts";

const exec = promisify(execFile);
const THREAD_ID = ThreadId.make("thread-bridge");
const PROJECT_ID = ProjectId.make("project-bridge");
const URL = "https://gitlab.com/team/repo/-/merge_requests/12";

const project = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "gitlab.com/team/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@gitlab.com:team/repo.git",
    },
    provider: "gitlab",
    displayName: "team/repo",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as OrchestrationProjectShell;

// Upstream's T3 tools act only for a caller that owns a live run.
const thread = (interactionMode: "default" | "plan") => ({
  ...v2PullRequestThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  }),
  activeRunId: RunId.make("run-bridge"),
});

/** Upstream's pull-request handlers behind the Coder registry, reached through the real CLI. */
const harness = (options: {
  readonly mode?: "default" | "plan";
  /** Holds pull-request dispatch until the test opens it. */
  readonly dispatchGate?: Deferred.Deferred<void>;
}) =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationV2ServerCommand> = [];
    const services = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (id) =>
          Effect.succeed(id === THREAD_ID ? thread(options.mode ?? "default") : null),
        dispatch: (command) =>
          (options.dispatchGate ? Deferred.await(options.dispatchGate) : Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
            ),
          ),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getShell: () => Effect.succeed(Option.some(project)),
        listShells: () => Effect.succeed([project]),
      }),
      Layer.succeed(
        CoderEnvironment.CoderEnvironment,
        CoderEnvironment.CoderEnvironment.of({
          descriptor: {
            environmentId: EnvironmentId.make("environment-bridge"),
            label: "Workspace",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      ),
      // The other toolkits capture these; only reading the calling thread is exercised here.
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(id === THREAD_ID ? thread(options.mode ?? "default") : null),
      }),
      ServerSettings.layerTest(),
      Layer.mock(GitWorkflowService.GitWorkflowService)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      T3ToolDispatch.layer,
      NodeServices.layer,
    );
    const context = yield* Layer.build(services);
    const tools = Context.get(context, T3ToolDispatch.T3ToolDispatch);
    const binding = yield* T3ToolBridge.makeBindingWith({ inlineBudgetMs: 200 }).pipe(
      Effect.provide(context),
    );
    yield* tools.bind(binding);
    const registry = yield* McpSessionRegistry.__testing.make().pipe(Effect.provide(context));
    const credential = yield* registry.issue({
      threadId: THREAD_ID,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const command = credential.config.toolCommand!;
    const call = (...args: Array<string>) =>
      Effect.promise(() =>
        exec("/bin/sh", ["-c", `${command} ${args.map((arg) => `'${arg}'`).join(" ")}`]).then(
          (result) => ({ ok: true as const, output: JSON.parse(result.stdout) as unknown }),
          (error: { stdout: string; stderr: string }) => ({
            ok: false as const,
            output: error.stdout ? (JSON.parse(error.stdout) as unknown) : error.stderr,
          }),
        ),
      );
    return { registry, credential, call, commands };
  });

it.live("links a merge request through the bridge CLI with upstream's handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, commands, registry, credential } = yield* harness({});
      const linked = yield* call("link_pull_request", JSON.stringify({ url: URL }));
      assert.deepStrictEqual(linked, {
        ok: true,
        output: {
          host: "gitlab.com",
          repository: "team/repo",
          number: 12,
          url: URL,
          alreadyLinked: false,
        },
      });
      assert.deepInclude(commands[0], {
        type: "thread.pull-request.link",
        threadId: THREAD_ID,
        source: "agent",
      });
      const rejected = yield* call(
        "link_pull_request",
        JSON.stringify({ url: "https://github.com/team/repo/pull/1" }),
      );
      assert.deepInclude(rejected, { ok: false });
      assert.deepInclude(rejected.output as object, { error: "PullRequestUrlInvalidError" });
      const unknown = yield* call("preview_open", "{}");
      assert.deepInclude(unknown.output as object, { error: "UnknownTool" });

      yield* registry.revokeThread(THREAD_ID);
      yield* Effect.promise(() =>
        access(credential.config.endpoint).then(
          () => assert.fail("bridge directory still exists"),
          () => undefined,
        ),
      );
    }),
  ),
);

it.live("permits only read-only tools in plan mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call, commands } = yield* harness({ mode: "plan" });
      const listed = yield* call("list_thread_pull_requests", "{}");
      assert.deepInclude(listed, { ok: true });
      const linked = yield* call("link_pull_request", JSON.stringify({ url: URL }));
      assert.deepInclude(linked.output as object, { error: "PlanModeReadOnly" });
      assert.lengthOf(commands, 0);
    }),
  ),
);

it.live("answers a slow call with a task id that task_status resolves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { call, commands } = yield* harness({ dispatchGate: gate });
      const started = yield* call("link_pull_request", JSON.stringify({ url: URL }));
      const { taskId } = started.output as { status: string; taskId: string };
      assert.deepInclude(started.output as object, { status: "running" });
      assert.match(taskId, /^bridge-job:/u);
      const running = yield* call("task_status", JSON.stringify({ taskId }));
      assert.deepInclude(running.output as object, { status: "running" });
      yield* Deferred.succeed(gate, undefined);
      let finished = yield* call("task_status", JSON.stringify({ taskId }));
      for (let attempt = 0; attempt < 50 && "status" in (finished.output as object); attempt++) {
        yield* Effect.sleep(50);
        finished = yield* call("task_status", JSON.stringify({ taskId }));
      }
      assert.deepInclude(finished.output as object, { number: 12, alreadyLinked: false });
      assert.lengthOf(commands, 1);
      const consumed = yield* call("task_status", JSON.stringify({ taskId }));
      assert.deepInclude(consumed.output as object, { error: "TaskNotFound" });
    }),
  ),
);

// The handler reads the calling thread and settings when it runs, not when it is built.
it.live("runs a toolkit whose handler needs runtime services", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { call } = yield* harness({});
      const read = yield* call("t3_environment_read", "{}");
      assert.deepInclude(read, { ok: true }, JSON.stringify(read));
      assert.deepInclude(read.output as object, { environmentId: "environment-bridge" });
    }),
  ),
);

// Upstream's core toolkit test checks the same catalog shape for its MCP server.
it("publishes unique tools with reference-free object-root input schemas", () => {
  const names = T3ToolBridge.T3_TOOL_CATALOG.map((entry) => entry.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const entry of T3ToolBridge.T3_TOOL_CATALOG) {
    assert.deepInclude(entry.inputSchema as object, { type: "object" }, entry.name);
    assert.notInclude(JSON.stringify(entry.inputSchema), '"$ref"', entry.name);
    assert.isAbove(entry.description.length, 0, entry.name);
  }
  for (const name of ["delegate_task", "task_status", "t3_thread_launch", "link_pull_request"]) {
    assert.include(names, name);
  }
  for (const name of ["preview_open", "device_list", "t3_attachment_prepare_upload"]) {
    assert.notInclude(names, name);
  }
});
