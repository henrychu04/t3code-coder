import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver derives the default worktree path from the repo and branch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-naming-" });
    const repo = path.join(fixtureRoot, "semantic-repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);

    const created = yield* driver.createWorktree({
      cwd: repo,
      refName: "main",
      newRefName: "t3code/fix-reconnect",
      baseRefName: "main",
      path: null,
    });
    assert.strictEqual(
      created.worktree.path.endsWith(
        path.join("worktrees", "semantic-repo", "t3code-fix-reconnect"),
      ),
      true,
    );
    assert.strictEqual(yield* fileSystem.exists(created.worktree.path), true);

    yield* driver.removeWorktree({ cwd: repo, path: created.worktree.path, force: true });
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver treats an already-gone worktree as a no-op", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-missing-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);

    yield* driver.removeWorktree({
      cwd: repo,
      path: path.join(fixtureRoot, "missing-worktree"),
    });
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver rejects an existing directory that is not a worktree", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-invalid-" });
    const repo = path.join(fixtureRoot, "repo");
    const notAWorktree = path.join(fixtureRoot, "not-a-worktree");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(notAWorktree);
    yield* runGit(repo, ["init", "--initial-branch=main"]);

    const error = yield* driver
      .removeWorktree({ cwd: repo, path: notAWorktree })
      .pipe(Effect.flip);
    assert.strictEqual(error.detail, "git worktree remove failed");
    assert.notProperty(error, "cause");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver removes the same worktree twice and prunes stale registrations", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-repeat-" });
    const repo = path.join(fixtureRoot, "repo");
    const sharedPath = path.join(fixtureRoot, "shared");
    const stalePath = path.join(fixtureRoot, "stale");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);

    yield* driver.createWorktree({
      cwd: repo,
      refName: "main",
      newRefName: "feature/shared",
      path: sharedPath,
    });
    yield* driver.removeWorktree({ cwd: repo, path: sharedPath });
    yield* driver.removeWorktree({ cwd: repo, path: sharedPath });

    yield* driver.createWorktree({
      cwd: repo,
      refName: "main",
      newRefName: "feature/stale",
      path: stalePath,
    });
    yield* fileSystem.remove(stalePath, { recursive: true });
    yield* driver.removeWorktree({
      cwd: repo,
      path: path.join(fixtureRoot, "never-registered"),
    });

    const registered = yield* driver.execute({
      operation: "GitVcsDriver.test.worktreeList",
      cwd: repo,
      args: ["worktree", "list", "--porcelain"],
    });
    assert.notInclude(registered.stdout, "feature/stale");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver renames a checked-out branch and moves its worktree", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-rename-" });
    const repo = path.join(fixtureRoot, "repo");
    const oldWorktreePath = path.join(fixtureRoot, "old-worktree");
    const newWorktreePath = path.join(fixtureRoot, "renamed-worktree");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);

    yield* driver.createWorktree({
      cwd: repo,
      refName: "main",
      newRefName: "feature/old-name",
      baseRefName: "main",
      path: oldWorktreePath,
    });
    yield* driver.renameBranch({
      cwd: oldWorktreePath,
      oldBranch: "feature/old-name",
      newBranch: "feature/new-name",
    });
    yield* driver.moveWorktree({
      cwd: repo,
      oldPath: oldWorktreePath,
      newPath: newWorktreePath,
    });

    const status = yield* driver.statusDetailsLocal(newWorktreePath);
    assert.strictEqual(status.branch, "feature/new-name");
    assert.strictEqual(yield* fileSystem.exists(oldWorktreePath), false);
    assert.strictEqual(yield* fileSystem.exists(newWorktreePath), true);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);
