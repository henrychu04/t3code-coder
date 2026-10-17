import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "@t3tools/provider-acp-registry/testing";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const decoded = Option.getOrUndefined(decodeUnknownJson(line.trim()));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) return decoded;
  }
  return undefined;
}

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2", () => {
  // Coder: Mistral Vibe's rate-limit classification is not carried.
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure(limit), {
      class: "provider_error",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(
      acpRegistryPromptFailure(new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as the Kilo Code driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      commandArgs: ["acp"],
      enabled: false,
      commandPath: "kilo",
      customModels: [],
    });
  });

  describe("the agent's own mode picker", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({}),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }],
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(Effect.scoped);
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  // Coder: Devin's client terminals are not carried; Kilo Code gets neither client fs nor terminals.
  it.effect("offers Kilo Code no client terminals or client fs", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let clientCapabilities: unknown;
      const instanceId = ProviderInstanceId.make("acp-registry-capabilities");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({}),
        environment: {},
        makeRuntime: (input) =>
          Effect.gen(function* () {
            clientCapabilities = input.clientCapabilities;
            const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: input.cwd,
                  env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                },
                authMethodId: "test",
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
          }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      yield* adapter.openSession({
        threadId: ThreadId.make("thread-acp-registry-capabilities"),
        providerSessionId: ProviderSessionId.make("provider-session-capabilities"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });

      assert.deepInclude(clientCapabilities, {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from the local command", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog();
      const settings = yield* decodeAcpRegistryAdapterSettings({
        commandPath: process.execPath,
        commandArgs: [mockAgentPath],
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (agentId, effect) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    assert.equal(agentId, `local:${instanceId}`);
                    startupActive = true;
                    startupCount += 1;
                  }),
                  () => effect,
                  () =>
                    Effect.sync(() => {
                      startupActive = false;
                    }),
                ),
              runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
              clearAvailableCommands: () => Effect.void,
              publishAvailableCommands: (publishedInstanceId, commands) =>
                Deferred.succeed(commandsPublished, {
                  instanceId: publishedInstanceId,
                  commands,
                }).pipe(Effect.asVoid),
              getAvailableCommands: () => Effect.succeed(Option.none()),
              watchAvailableCommands: () => Effect.never,
              clearLiveConfiguration: () => Effect.void,
              publishLiveConfiguration: (_publishedInstanceId, configuration) =>
                Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
              getLiveConfiguration: () => Effect.succeed(Option.none()),
              watchLiveConfiguration: () => Effect.never,
            }),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                Effect.sync(() => assert.isTrue(startupActive)).pipe(
                  Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
                ),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Coder: T3 starts no agent sign-in. When Kilo Code reports that authentication is required,
  // the session fails instead of calling ACP `authenticate` with an agent-managed method.
  it.effect("fails an unauthenticated session instead of signing in", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog();
      const instanceId = ProviderInstanceId.make("acp-registry-auth-required");
      const threadId = ThreadId.make("thread-acp-registry-auth-required");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          commandPath: process.execPath,
          commandArgs: [mockAgentPath],
        }),
        environment: { T3_ACP_SESSION_LIFECYCLE: "1", T3_ACP_REQUIRE_AUTH: "1" },
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, resolver));
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const result = yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-registry-auth-required"),
          modelSelection,
          runtimePolicy,
        });
        return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      }).pipe(Effect.result);

      assert.isTrue(result._tag === "Failure", "an auth-required session must not sign in");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Coder: T3 tools reach Kilo Code over the workspace file bridge. No MCP server is attached to
  // its session, and the first prompt names the thread's bridge command.
  it.live("describes the workspace file bridge instead of attaching an MCP server", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-registry-file-bridge");
      const threadId = ThreadId.make("thread-acp-registry-file-bridge");
      const toolCommand = "/usr/bin/node /tmp/t3-tools-bridge/t3.mjs";
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-registry-file-bridge"),
        threadId,
        providerSessionId: "mcp-session-acp-registry-file-bridge",
        providerInstanceId: instanceId,
        endpoint: "/tmp/t3-tools-bridge",
        authorizationHeader: "",
        browserToolsAvailable: false,
        toolCommand,
      });
      let mcpServers: ReadonlyArray<unknown> | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({}),
        environment: {},
        makeRuntime: (input) =>
          Effect.gen(function* () {
            mcpServers = input.mcpServers;
            const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: input.cwd,
                  env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                },
                authMethodId: "test",
                protocolLogging: {
                  ...runtimeInput.protocolLogging,
                  logger: (event) => Queue.offer(protocolEvents, event).pipe(Effect.asVoid),
                },
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
          }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-file-bridge"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-acp-registry-file-bridge"),
          title: "Kilo file bridge",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-acp-registry-file-bridge"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-acp-registry-file-bridge"),
        rootNodeId: NodeId.make("node-acp-registry-file-bridge"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-acp-registry-file-bridge"),
          text: "List the T3 tools.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      let prompt: unknown;
      while (prompt === undefined) {
        const event = yield* Queue.take(protocolEvents);
        const request = event.direction === "outgoing" ? rawProtocolRequest(event) : undefined;
        if (request?.method === "session/prompt") prompt = request.params;
      }

      assert.deepEqual(mcpServers, []);
      const text = JSON.stringify(prompt);
      assert.include(text, `Run \`${toolCommand} <tool> '<json params>'\``);
      assert.include(text, "T3 Code interaction mode: Default");
      assert.notInclude(text, "t3-code` MCP server");
      assert.notInclude(text, "preview_");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
