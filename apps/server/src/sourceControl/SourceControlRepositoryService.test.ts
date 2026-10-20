import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { parseGitLabCloneSource } from "@t3tools/shared/sourceControl";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-repository-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => undefined,
  }),
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

const cloneUrls = {
  nameWithOwner: "group/subgroup/project",
  url: "https://gitlab.example/group/subgroup/project",
  sshUrl: "git@gitlab.example:group/subgroup/project.git",
};

for (const [repository, protocol, expectedUrl] of [
  [cloneUrls.url, undefined, cloneUrls.url],
  [`${cloneUrls.url}.git`, "auto", `${cloneUrls.url}.git`],
  [cloneUrls.sshUrl, undefined, cloneUrls.sshUrl],
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
            kind: SourceControlProviderKind.make("gitlab"),
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
            resolveLink: () => undefined,
            get: () => Effect.succeed(provider),
          }),
        ),
        Effect.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.gen(function* () {
                // Upstream creates missing parent folders before cloning.
                assert.isTrue(yield* fileSystem.exists(input.cwd).pipe(Effect.orDie));
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
        provider: SourceControlProviderKind.make("gitlab"),
        ...source,
        ...(protocol === undefined ? {} : { protocol }),
        destinationPath: path.join(root, "missing", "nested", "project"),
      });
      assert.deepStrictEqual(calls, [["clone", "--progress", "--", expectedUrl, "project"]]);
      assert.strictEqual(result.remoteUrl, expectedUrl);
      const directUrl = "remoteUrl" in source;
      assert.strictEqual(lookupCount, directUrl ? 0 : 1);
      assert.strictEqual(result.repository?.url ?? null, directUrl ? null : cloneUrls.url);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
}

// Coder: upstream's filesystem-root case on a GitLab URL, mocked like the tests above.
it.effect("clones directly under an existing filesystem root without recreating it", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.parse(path.resolve(".")).root;
    const cloneCwds: Array<string> = [];
    const service = yield* SourceControlRepositoryService.make.pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: (input) =>
            Effect.sync(() => {
              cloneCwds.push(input.cwd);
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
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (target) => Effect.succeed(target === root),
          makeDirectory: (target) =>
            Effect.sync(() => {
              assert.notStrictEqual(target, root, "must not try to create the existing root");
            }),
        }),
      ),
    );
    yield* service.cloneRepository({
      provider: SourceControlProviderKind.make("gitlab"),
      remoteUrl: cloneUrls.url,
      destinationPath: path.join(root, "project"),
    });
    assert.deepStrictEqual(cloneCwds, [root]);
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
          provider: SourceControlProviderKind.make("gitlab"),
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

// Coder: upstream's publish push failure tests on GitLab, built like the clone tests above.
function makePublishService(reason?: GitCommandError["reason"]) {
  return SourceControlRepositoryService.make.pipe(
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        get: () =>
          SourceControlProvider.SourceControlProvider.pipe(
            Effect.provide(
              Layer.mock(SourceControlProvider.SourceControlProvider)({
                kind: SourceControlProviderKind.make("gitlab"),
                createRepository: () => Effect.succeed(cloneUrls),
              }),
            ),
          ),
      }),
    ),
    Effect.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () =>
          Effect.succeed({
            stdout: "",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: (cwd: string) =>
          Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
              command: "git",
              cwd,
              ...(reason === undefined ? {} : { reason }),
              detail: "Git command exited with a non-zero status.",
            }),
          ),
      }),
    ),
  );
}

it.effect("explains a rejected SSH push after creating the repository", () =>
  Effect.gen(function* () {
    const service = yield* makePublishService("authentication_failed");
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("gitlab"),
        repository: cloneUrls.nameWithOwner,
        visibility: "private",
        protocol: "ssh",
      }),
    );

    assert.strictEqual(error.operation, "publishRepository");
    assert.match(
      error.detail,
      /^Created group\/subgroup\/project and added it as remote "origin", but the push failed because SSH authentication was rejected\./,
    );
    assert.instanceOf(error.cause, GitCommandError);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("says the repository exists when an unclassified publish push fails", () =>
  Effect.gen(function* () {
    const service = yield* makePublishService();
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("gitlab"),
        repository: cloneUrls.nameWithOwner,
        visibility: "private",
        protocol: "https",
      }),
    );

    assert.strictEqual(
      error.detail,
      'Created group/subgroup/project and added it as remote "origin", but the push failed. Fix the problem, then push again.',
    );
  }).pipe(Effect.provide(TestLayer)),
);
