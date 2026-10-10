import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

function makeRegistry(remoteUrl: string) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [{ name: "origin", url: remoteUrl, pushUrl: Option.none(), isPrimary: true }],
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "git",
              repository: {
                kind: "git",
                rootPath: "/repo",
                metadataPath: null,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              },
              driver: driver as unknown as VcsDriver.VcsDriver["Service"],
            }),
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        TestSourceControlHost.layer(),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("detects the GitLab provider when resolve is called without explicit context", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry("git@gitlab.com:group/project.git");
    const handle = yield* registry.resolveHandle({ cwd: "/repo" });

    assert.strictEqual(handle.provider.kind, "gitlab");
    assert.strictEqual(handle.context?.remoteName, "origin");
    assert.strictEqual(handle.context?.remoteUrl, "git@gitlab.com:group/project.git");
  }),
);
