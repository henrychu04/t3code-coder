// Coder: upstream's registry tests for the GitLab-only registry; the other hosts' mocks and
// routing cases are not carried.
import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderKind,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly process?: Partial<VcsProcess.VcsProcess["Service"]>;
  readonly settings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layerRegistry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver["Service"]),
    resolve: () =>
      Effect.succeed({
        kind: "git",
        repository: {
          kind: "git",
          rootPath: "/repo",
          metadataPath: null,
          freshness: {
            source: "live-local" as const,
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        },
        driver: driver as unknown as VcsDriver.VcsDriver["Service"],
      }),
  });

  const layerProcess = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput("")),
    ...input.process,
  });

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerRegistry,
        layerProcess,
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerProcess,
              layerRegistry,
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
        ),
        input.settings
          ? Layer.mock(ServerSettings.ServerSettingsService)(input.settings)
          : ServerSettings.ServerSettingsService.layerTest(),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("detects the GitLab provider when resolve is called without explicit context", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });
    const handle = yield* registry.resolveHandle({ cwd: "/repo" });

    assert.strictEqual(handle.provider.kind, "gitlab");
    assert.strictEqual(handle.context?.remoteName, "origin");
    assert.strictEqual(handle.context?.remoteUrl, "git@gitlab.com:group/project.git");
  }),
);

const notFound = (command: string, cwd: string) =>
  new VcsProcessSpawnError({
    operation: "test",
    command,
    cwd,
    cause: PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
  });

const resolveUnknown = (
  registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  repository: string,
) =>
  registry.resolveHandle({
    cwd: `/${repository}`,
    context: {
      provider: {
        kind: SourceControlProviderKind.make("unknown"),
        name: "git.example.internal",
        baseUrl: "https://git.example.internal",
      },
      remoteName: "origin",
      remoteUrl: `git@Git.Example.Internal:team/${repository}.git`,
    },
  });

it.effect("asks once for every checkout of a server no integration claims", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: ({ command, args, cwd }) => {
          asked.push([command, ...args].join(" "));
          return Deferred.await(release).pipe(Effect.andThen(Effect.fail(notFound(command, cwd))));
        },
      },
    });

    // Three checkouts read while the first probe is still running share it.
    const started = yield* Effect.forEach(["a", "b", "c"], () => Deferred.make<void>());
    const callers = yield* Effect.forEach(
      ["a", "b", "c"],
      (repository, index) =>
        Deferred.succeed(started[index]!, undefined).pipe(
          Effect.andThen(resolveUnknown(registry, repository)),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Effect.forEach(started, Deferred.await);
    yield* Deferred.succeed(release, undefined);
    const handles = yield* Fiber.join(callers);
    yield* resolveUnknown(registry, "d");
    assert.deepStrictEqual(
      handles.map((handle) => handle.provider.kind),
      ["unknown", "unknown", "unknown"],
    );
    const once = asked.slice();
    // glab is asked about the remote's host as the remote spells it.
    assert.deepStrictEqual(once, ["glab auth status --hostname Git.Example.Internal"]);

    // A login made in a terminal sends no signal, so the server is asked again later.
    yield* TestClock.adjust("5 minutes");
    yield* resolveUnknown(registry, "a");
    assert.deepStrictEqual(asked, [...once, ...once]);
  }),
);

it.effect("asks again after a check that could not answer", () =>
  Effect.gen(function* () {
    let asks = 0;
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: ({ command, cwd }) => {
          asks += 1;
          return Effect.fail(
            new VcsProcessTimeoutError({ operation: "test", command, cwd, timeoutMs: 1 }),
          );
        },
      },
    });
    yield* resolveUnknown(registry, "a");
    yield* resolveUnknown(registry, "b");
    assert.strictEqual(asks, 2);
  }),
);

it.effect("asks again once Settings change", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const handled = yield* Deferred.make<void>();
    let signedIn = false;
    const registry = yield* makeRegistry({
      remotes: [],
      settings: {
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) =>
            // A change is handled once the registry asks for the next one.
            Stream.fromSubscription(subscription).pipe(
              Stream.flatMap((settings) =>
                Stream.concat(
                  Stream.make(settings),
                  Stream.fromEffectDrain(Deferred.succeed(handled, undefined)),
                ),
              ),
            ),
          ),
        ),
      },
      process: {
        run: ({ command, cwd }) =>
          signedIn
            ? Effect.succeed(
                processOutput(
                  `git.example.internal
  ✓ Logged in to git.example.internal as gitlab-user
`,
                ),
              )
            : Effect.fail(notFound(command, cwd)),
      },
    });
    assert.strictEqual((yield* resolveUnknown(registry, "a")).provider.kind, "unknown");
    signedIn = true;
    assert.strictEqual((yield* resolveUnknown(registry, "b")).provider.kind, "unknown");

    // A host toggled in Settings.
    yield* PubSub.publish(changes, DEFAULT_SERVER_SETTINGS);
    yield* Deferred.await(handled);
    assert.strictEqual((yield* resolveUnknown(registry, "c")).provider.kind, "gitlab");
  }),
);
