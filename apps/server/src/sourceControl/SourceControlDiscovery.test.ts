import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

it.effect("combines Git, GitLab discovery, and the workspace write policy", () => {
  const layer = SourceControlDiscovery.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "git version 2.51.0\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        discover: Effect.succeed([
          {
            kind: "gitlab",
            label: "GitLab",
            executable: "glab",
            status: "available",
            version: Option.some("glab 1.79.0"),
            installHint: "Install glab.",
            detail: Option.none(),
            auth: {
              status: "authenticated",
              account: Option.some("coder-user"),
              host: Option.some("gitlab.example.com"),
              detail: Option.none(),
            },
          },
        ]),
      }),
    ),
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        probeWriteAccess: () => Effect.succeed({ status: "policy-blocked", writable: false }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.strictEqual(result.versionControlSystems[0]?.status, "available");
    assert.strictEqual(
      Option.getOrNull(result.versionControlSystems[0]!.version),
      "git version 2.51.0",
    );
    assert.deepStrictEqual(result.sourceControlProviders[0]?.writeAccess, {
      status: "policy-blocked",
      writable: false,
    });
  }).pipe(Effect.provide(layer));
});
