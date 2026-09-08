import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  SourceControlProviderError,
  type SourceControlCloneProtocol,
} from "@t3tools/contracts";
import { parseGitLabCloneSource } from "@t3tools/shared/sourceControl";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
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

const cloneUrls = {
  nameWithOwner: "group/subgroup/project",
  url: "https://gitlab.example/group/subgroup/project",
  sshUrl: "git@gitlab.example:group/subgroup/project.git",
};

for (const [repository, protocol, expectedUrl] of [
  [cloneUrls.url, undefined, cloneUrls.url],
  [`${cloneUrls.url}.git`, "auto", `${cloneUrls.url}.git`],
  [cloneUrls.sshUrl, undefined, cloneUrls.sshUrl],
  [
    "ssh://git@gitlab.example:2222/group/subgroup/project.git",
    undefined,
    "ssh://git@gitlab.example:2222/group/subgroup/project.git",
  ],
  [cloneUrls.nameWithOwner, undefined, cloneUrls.sshUrl],
  [cloneUrls.nameWithOwner, "https", cloneUrls.url],
] satisfies Array<[string, SourceControlCloneProtocol | undefined, string]>) {
  it.effect(`clones ${repository} with protocol ${protocol ?? "default"}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-clone-protocol-" });
      let lookupCount = 0;
      const source = parseGitLabCloneSource(repository);
      assert.ok(source);
      const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
        Effect.provide(
          Layer.mock(SourceControlProvider.SourceControlProvider)({
            kind: "gitlab",
            getRepositoryCloneUrls: () =>
              Effect.sync(() => {
                lookupCount++;
                return cloneUrls;
              }),
          }),
        ),
      );
      const calls: Array<ReadonlyArray<string>> = [];
      const service = yield* SourceControlRepositoryService.make.pipe(
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            get: () => Effect.succeed(provider),
          }),
        ),
        Effect.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.sync(() => {
                calls.push(input.args);
                return {
                  stdout: "",
                  stderr: "",
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      );
      const result = yield* service.cloneRepository({
        provider: "gitlab",
        ...source,
        ...(protocol === undefined ? {} : { protocol }),
        destinationPath: path.join(root, "project"),
      });
      assert.deepStrictEqual(calls, [["clone", "--", expectedUrl, "project"]]);
      assert.strictEqual(result.remoteUrl, expectedUrl);
      const directUrl = "remoteUrl" in source;
      assert.strictEqual(lookupCount, directUrl ? 0 : 1);
      assert.strictEqual(result.repository?.url ?? null, directUrl ? null : cloneUrls.url);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
}

it.effect(
  "preserves safe provider diagnostics without including raw command output in the message",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-clone-error-" });
      const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
        Effect.provide(
          Layer.mock(SourceControlProvider.SourceControlProvider)({
            kind: "gitlab",
            getRepositoryCloneUrls: () =>
              Effect.fail(
                new SourceControlProviderError({
                  provider: "gitlab",
                  operation: "getRepositoryCloneUrls",
                  cwd: root,
                  detail: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
                  cause: new Error("raw output containing secret"),
                }),
              ),
          }),
        ),
      );
      const service = yield* SourceControlRepositoryService.make.pipe(
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            get: () => Effect.succeed(provider),
          }),
        ),
      );
      const error = yield* service
        .cloneRepository({
          provider: "gitlab",
          repository: cloneUrls.nameWithOwner,
          destinationPath: path.join(root, "project"),
        })
        .pipe(Effect.flip);
      assert.ok(error.message.includes("not authenticated"));
      assert.ok(!error.message.includes("secret"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

for (const remoteUrl of [
  "https://user:secret@gitlab.example/group/project.git",
  "file:///group/project",
  "ext::command",
  "group/project",
  "https://github.com/group/project",
]) {
  it.effect(`rejects unsupported clone URL ${remoteUrl} before preparing the destination`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-clone-validation-" });
      const parent = path.join(root, "parent");
      const service = yield* SourceControlRepositoryService.make;
      const error = yield* service
        .cloneRepository({
          provider: "gitlab",
          remoteUrl,
          destinationPath: path.join(parent, "project"),
        })
        .pipe(Effect.flip);
      assert.ok(error.message.includes("Enter an HTTP(S) or SSH GitLab repository URL"));
      assert.ok(!error.message.includes("secret"));
      assert.strictEqual(yield* fileSystem.exists(parent), false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
}
