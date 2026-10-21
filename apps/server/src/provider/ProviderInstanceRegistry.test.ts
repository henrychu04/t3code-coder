import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import * as ClaudeCli from "./Drivers/ClaudeCli.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
// Coder: the Claude probe runs through the workspace CLI transport.
vi.mock("./Drivers/ClaudeCli.ts", { spy: true });

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunScopeWork: () => Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  // Coder: the Codex stand-in wrapper is written here rather than tracked, so the source archive
  // carries no shell script (a corporate download scanner rejects archives that do).
  yield* fileSystem.writeFileString(
    codexPath,
    '#!/usr/bin/env bash\nshift\nexec node "$(dirname "$0")/codexCollabMockPeer.mjs" "$@"\n',
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provideMerge(layerBase),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv | ClaudeDriverEnv>({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Claude instance probes in the server state dir, not the server cwd", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const claudeId = ProviderInstanceId.make("claude_state_dir");
      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            // Packaged desktop builds start the server in $HOME, where some
            // `claude` wrappers refuse to run.
            environment: [{ name: "T3_CLAUDE_REQUIRED_CWD", value: stateDir, sensitive: false }],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);

      expect(yield* claude!.snapshot.refresh).toMatchObject({
        status: "ready",
        version: "2.1.219",
        auth: { status: "authenticated" },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  // Coder: upstream's organization-scoped fallback test, without the organization change the
  // fork does not read, against the CLI transport.
  it.effect("reuses the last good Claude capabilities once after a failed probe", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const claudeId = ProviderInstanceId.make("claude_probe_recovery");
      let probeCount = 0;
      let successfulProbeCount = 0;
      let failProbe = false;
      const query = vi.spyOn(ClaudeCli, "query").mockImplementation(
        () =>
          ({
            initializationResult: () => {
              probeCount++;
              if (failProbe) return Promise.reject(new Error("initialization failed"));
              successfulProbeCount++;
              return Promise.resolve({
                commands: [
                  {
                    name: successfulProbeCount === 1 ? "last-good" : "recovered",
                    description: "",
                    argumentHint: "",
                  },
                ],
                account: {
                  email: "account@example.com",
                  subscriptionType: "pro",
                  tokenSource: "oauth",
                },
              });
            },
            getUsage: async () => ({
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" },
              },
            }),
          }) as unknown as ReturnType<typeof ClaudeCli.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);
      expect(claude).toBeDefined();

      const first = yield* claude!.snapshot.refresh;
      expect(first).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account@example.com" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      });
      expect(first.usageLimits?.unavailable).toBeUndefined();
      expect(probeCount).toBe(1);

      // One failed probe reuses the last good capabilities, without their usage windows. The
      // clock stays put: advancing it runs the background status refresh, which would spend
      // the one fallback before this refresh.
      yield* claude!.invalidateCaches ?? Effect.void;
      failProbe = true;
      const fallback = yield* claude!.snapshot.refresh;
      expect(fallback).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account@example.com" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      });
      expect(fallback.usageLimits?.checkedAt).toBe(first.usageLimits?.checkedAt);
      const fallbackProbeCount = probeCount;
      expect(fallbackProbeCount).toBeGreaterThan(1);

      // The fallback earns no TTL and is spent: the next failure shows.
      const repeatedFailure = yield* claude!.snapshot.refresh;
      expect(repeatedFailure).toMatchObject({
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Agent CLI failed while checking account status.",
      });
      expect(repeatedFailure.slashCommands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      );
      expect(probeCount).toBeGreaterThan(fallbackProbeCount);

      failProbe = false;
      const recovered = yield* claude!.snapshot.refresh;
      expect(recovered).toMatchObject({
        status: "ready",
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      });
      expect(recovered.usageLimits?.unavailable).toBeUndefined();
    }).pipe(Effect.provide(layerTest)),
  );

  const makeClaudeCacheFixture = Effect.fnUntraced(function* (
    state: "ready" | "signed-out" | "usage-failed",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = yield* makeTildeProviderFixtures();
    const recovered = path.join(fixtures.claudeHomePath, "recovered");
    const probeLog = path.join(fixtures.claudeHomePath, "probes.log");
    const instanceId = ProviderInstanceId.make("claude_cache");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_PROBE_LOG", value: probeLog, sensitive: false },
            ...(state === "ready"
              ? []
              : [
                  {
                    name:
                      state === "signed-out"
                        ? "T3_CLAUDE_LOGIN_MARKER"
                        : "T3_CLAUDE_USAGE_FAILS_UNTIL",
                    value: recovered,
                    sensitive: false,
                  },
                ]),
          ],
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    return {
      refresh: instance!.snapshot.refresh,
      recover: fs.writeFileString(recovered, ""),
      probeLog: fs.readFileString(probeLog),
    };
  });

  for (const state of ["signed-out", "usage-failed"] as const) {
    it.effect.skipIf(windowsHost)(
      state === "signed-out"
        ? "shows Claude usage on the first refresh after signing back in"
        : "retries Claude usage on the first refresh after a failed usage read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeClaudeCacheFixture(state);
          const before = yield* fixture.refresh;
          if (state === "signed-out") {
            expect(before.auth.status).toBe("unauthenticated");
            expect(before.usageLimits).toBeUndefined();
          } else {
            expect(before.auth.status).toBe("authenticated");
            expect(before.usageLimits?.unavailable?.reason).toBe("probeFailed");
          }

          yield* fixture.recover;
          const after = yield* fixture.refresh;
          expect(after.auth.status).toBe("authenticated");
          expect(after.usageLimits?.unavailable).toBeUndefined();
          expect(after.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
        }).pipe(Effect.provide(layerTest)),
    );
  }

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(layerTest)),
  );
});
