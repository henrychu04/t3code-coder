import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-repository-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (input) =>
      Effect.sync(() => {
        const directoryName = input.args.at(-1)!;
        const destination = NodePath.join(input.cwd, directoryName);
        NodeFS.mkdirSync(destination, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(destination, "partial-clone"), "partial\n");
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git clone",
              cwd: input.cwd,
              detail: "Clone failed for the test.",
            }),
          ),
        ),
      ),
  }),
);

it.effect("clone cleanup removes only a destination created by the failed operation", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const service = yield* SourceControlRepositoryService.make;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-clone-cleanup-" });
    const preExisting = path.join(fixtureRoot, "existing");
    const createdByClone = path.join(fixtureRoot, "new");
    yield* fileSystem.makeDirectory(preExisting);

    yield* service
      .cloneRepository({
        provider: "gitlab",
        remoteUrl: "https://gitlab.example/group/project.git",
        destinationPath: preExisting,
      })
      .pipe(Effect.flip);
    yield* service
      .cloneRepository({
        provider: "gitlab",
        remoteUrl: "https://gitlab.example/group/project.git",
        destinationPath: createdByClone,
      })
      .pipe(Effect.flip);

    assert.strictEqual(yield* fileSystem.exists(preExisting), true);
    assert.strictEqual(yield* fileSystem.exists(path.join(preExisting, "partial-clone")), true);
    assert.strictEqual(yield* fileSystem.exists(createdByClone), false);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
