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

const readGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.readGit",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
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

    const error = yield* driver.removeWorktree({ cwd: repo, path: notAWorktree }).pipe(Effect.flip);
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

it.effect("GitVcsDriver adds a remote and pushes the current branch with upstream tracking", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-push-" });
    const repo = path.join(fixtureRoot, "repo");
    const remote = path.join(fixtureRoot, "remote.git");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(remote);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(remote, ["init", "--bare", "--initial-branch=main"]);

    const remoteName = yield* driver.ensureRemote({
      cwd: repo,
      preferredName: "origin",
      url: remote,
    });
    const pushed = yield* driver.pushCurrentBranch(repo, null, { remoteName });

    assert.strictEqual(remoteName, "origin");
    assert.strictEqual(pushed.branch, "main");
    assert.strictEqual(pushed.upstreamBranch, "origin/main");
    assert.strictEqual(pushed.setUpstream, true);
    assert.strictEqual(
      yield* readGit(remote, ["rev-parse", "refs/heads/main"]),
      yield* readGit(repo, ["rev-parse", "HEAD"]),
    );
    assert.strictEqual(
      yield* driver.ensureRemote({ cwd: repo, preferredName: "origin", url: remote }),
      "origin",
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver pushes to an explicitly requested remote instead of an old upstream", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-republish-" });
    const repo = path.join(fixtureRoot, "repo");
    const oldRemote = path.join(fixtureRoot, "old.git");
    const requestedRemote = path.join(fixtureRoot, "requested.git");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(oldRemote);
    yield* fileSystem.makeDirectory(requestedRemote);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "first\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "First"]);
    yield* runGit(oldRemote, ["init", "--bare", "--initial-branch=main"]);
    yield* runGit(requestedRemote, ["init", "--bare", "--initial-branch=main"]);
    yield* driver.ensureRemote({ cwd: repo, preferredName: "origin", url: oldRemote });
    yield* driver.pushCurrentBranch(repo, null, { remoteName: "origin" });
    const oldHead = yield* readGit(oldRemote, ["rev-parse", "refs/heads/main"]);

    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "second\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Second"]);
    const remoteName = yield* driver.ensureRemote({
      cwd: repo,
      preferredName: "published",
      url: requestedRemote,
    });
    const pushed = yield* driver.pushCurrentBranch(repo, null, { remoteName });

    assert.strictEqual(remoteName, "published");
    assert.strictEqual(pushed.upstreamBranch, "published/main");
    assert.strictEqual(pushed.setUpstream, true);
    assert.strictEqual(yield* readGit(oldRemote, ["rev-parse", "refs/heads/main"]), oldHead);
    assert.strictEqual(
      yield* readGit(requestedRemote, ["rev-parse", "refs/heads/main"]),
      yield* readGit(repo, ["rev-parse", "HEAD"]),
    );
    assert.strictEqual(
      yield* readGit(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
      "published/main",
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver uses the remote HEAD when determining the default branch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-default-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=trunk"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["branch", "main"]);
    yield* runGit(repo, ["remote", "add", "origin", repo]);
    yield* runGit(repo, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    yield* runGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);

    const status = yield* driver.statusDetailsLocal(repo);
    assert.strictEqual(status.branch, "trunk");
    assert.strictEqual(status.isDefaultBranch, true);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver uses a non-origin remote HEAD as the default branch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-upstream-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=develop"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["branch", "main"]);
    yield* runGit(repo, ["remote", "add", "upstream", repo]);
    yield* runGit(repo, ["update-ref", "refs/remotes/upstream/develop", "HEAD"]);
    yield* runGit(repo, [
      "symbolic-ref",
      "refs/remotes/upstream/HEAD",
      "refs/remotes/upstream/develop",
    ]);

    const status = yield* driver.statusDetailsLocal(repo);
    assert.strictEqual(status.branch, "develop");
    assert.strictEqual(status.isDefaultBranch, true);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver reports the destination of a rename with spaces", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-status-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(path.join(repo, "old dir"), { recursive: true });
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "old dir", "old name.txt"), "fixture\n");
    yield* runGit(repo, ["add", "."]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* fileSystem.makeDirectory(path.join(repo, "new dir"));
    yield* runGit(repo, ["mv", "old dir/old name.txt", "new dir/new name.txt"]);

    const status = yield* driver.statusDetailsLocal(repo);
    assert.deepEqual(
      status.workingTree.files.map((file) => file.path),
      ["new dir/new name.txt"],
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver preserves tabs in renamed paths", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-tab-path-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "old\tname.txt"), "fixture\n");
    yield* runGit(repo, ["add", "."]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["mv", "old\tname.txt", "new\tname.txt"]);

    const status = yield* driver.statusDetailsLocal(repo);
    assert.deepEqual(
      status.workingTree.files.map((file) => file.path),
      ["new\tname.txt"],
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver checks out cached submodules in a new worktree", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-submodule-" });
    const submoduleRepo = path.join(fixtureRoot, "shared-source");
    const repo = path.join(fixtureRoot, "repo");
    const worktree = path.join(fixtureRoot, "worktree");
    yield* fileSystem.makeDirectory(submoduleRepo);
    yield* runGit(submoduleRepo, ["init", "--initial-branch=main"]);
    yield* runGit(submoduleRepo, ["config", "user.email", "test@test.com"]);
    yield* runGit(submoduleRepo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(submoduleRepo, "SHARED.md"), "shared\n");
    yield* runGit(submoduleRepo, ["add", "."]);
    yield* runGit(submoduleRepo, ["commit", "-m", "Initial"]);

    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "."]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRepo,
      "shared",
    ]);
    yield* runGit(repo, ["commit", "-am", "Add submodule"]);

    yield* driver.createWorktree({
      cwd: repo,
      path: worktree,
      refName: "main",
      newRefName: "feature/submodule",
    });

    assert.strictEqual(yield* fileSystem.exists(path.join(worktree, "shared", "SHARED.md")), true);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver keeps a worktree when an uncached network submodule is blocked", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-broken-sub-" });
    const repo = path.join(fixtureRoot, "repo");
    const worktree = path.join(fixtureRoot, "worktree");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "fixture\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    const gitlinkCommit = yield* readGit(repo, ["rev-parse", "HEAD"]);
    yield* fileSystem.writeFileString(
      path.join(repo, ".gitmodules"),
      '[submodule "missing"]\n\tpath = missing\n\turl = https://example.invalid/missing.git\n',
    );
    yield* runGit(repo, ["add", ".gitmodules"]);
    yield* runGit(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      gitlinkCommit,
      "missing",
    ]);
    yield* runGit(repo, ["commit", "-m", "Add unavailable submodule"]);

    const created = yield* driver.createWorktree({
      cwd: repo,
      path: worktree,
      refName: "main",
      newRefName: "feature/broken-submodule",
    });

    assert.strictEqual(created.worktree.path, worktree);
    assert.strictEqual(yield* fileSystem.exists(worktree), true);
    assert.strictEqual(
      yield* fileSystem.exists(path.join(worktree, "missing", "README.md")),
      false,
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver resolves the automatic review base from local remote refs", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-review-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    const baseCommit = yield* driver.execute({
      operation: "GitVcsDriver.test.baseCommit",
      cwd: repo,
      args: ["rev-parse", "HEAD"],
    });
    yield* runGit(repo, ["remote", "add", "origin", repo]);
    yield* runGit(repo, ["update-ref", "refs/remotes/origin/main", baseCommit.stdout.trim()]);
    yield* runGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    yield* runGit(repo, ["switch", "-c", "feature/review"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\nfeature\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Feature"]);

    const preview = yield* driver.getReviewDiffPreview({
      cwd: repo,
      sourceKind: "branch-range",
    });

    assert.lengthOf(preview.sources, 1);
    assert.strictEqual(preview.sources[0]?.kind, "branch-range");
    assert.strictEqual(preview.sources[0]?.baseRef, "origin/main");
    assert.include(preview.sources[0]?.diff ?? "", "+feature");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver preserves empty review sources and includes untracked files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-preview-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["switch", "-c", "feature/preview"]);

    const cleanBranch = yield* driver.getReviewDiffPreview({
      cwd: repo,
      sourceKind: "branch-range",
    });
    assert.lengthOf(cleanBranch.sources, 1);
    assert.deepInclude(cleanBranch.sources[0], {
      kind: "branch-range",
      baseRef: "main",
      headRef: "feature/preview",
      diff: "",
    });

    yield* fileSystem.writeFileString(path.join(repo, "untracked.txt"), "untracked\n");
    const workingTree = yield* driver.getReviewDiffPreview({
      cwd: repo,
      sourceKind: "working-tree",
    });
    assert.lengthOf(workingTree.sources, 1);
    assert.strictEqual(workingTree.sources[0]?.kind, "working-tree");
    assert.include(workingTree.sources[0]?.diff ?? "", "untracked.txt");
    assert.include(workingTree.sources[0]?.diff ?? "", "+untracked");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver bypasses textconv filters in review previews", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-textconv-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* runGit(repo, ["config", "diff.review.textconv", "false"]);
    yield* fileSystem.writeFileString(path.join(repo, ".gitattributes"), "*.txt diff=review\n");
    yield* fileSystem.writeFileString(path.join(repo, "tracked.txt"), "base\n");
    yield* runGit(repo, ["add", ".gitattributes", "tracked.txt"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* fileSystem.writeFileString(path.join(repo, "tracked.txt"), "changed\n");

    const preview = yield* driver.getReviewDiffPreview({
      cwd: repo,
      sourceKind: "working-tree",
    });

    assert.include(preview.sources[0]?.diff ?? "", "+changed");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver expands branch files from the merge base", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-merge-base-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "common base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["switch", "-c", "feature/context"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "feature contents\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Feature"]);
    yield* runGit(repo, ["switch", "main"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "advanced main\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Advance main"]);
    yield* runGit(repo, ["switch", "feature/context"]);

    const contents = yield* driver.getReviewDiffFileContents({
      cwd: repo,
      sourceKind: "branch-range",
      changeType: "change",
      baseRef: "main",
      headRef: "feature/context",
      oldPath: "README.md",
      newPath: "README.md",
    });

    assert.deepStrictEqual(contents, {
      oldContents: "common base\n",
      newContents: "feature contents\n",
    });
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver contains working-tree expansion and rejects binary files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-safe-diff-" });
    const repo = path.join(fixtureRoot, "repo");
    const outsideFile = path.join(fixtureRoot, "secret.txt");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* fileSystem.writeFileString(outsideFile, "secret\n");
    yield* fileSystem.symlink(outsideFile, path.join(repo, "linked.txt"));

    const escaped = yield* driver
      .getReviewDiffFileContents({
        cwd: repo,
        sourceKind: "working-tree",
        changeType: "new",
        baseRef: "HEAD",
        headRef: null,
        oldPath: "linked.txt",
        newPath: "linked.txt",
      })
      .pipe(Effect.flip);
    assert.strictEqual(escaped._tag, "GitCommandError");
    assert.include(escaped.message, "escapes the workspace");

    const missing = yield* driver
      .getReviewDiffFileContents({
        cwd: repo,
        sourceKind: "working-tree",
        changeType: "new",
        baseRef: "HEAD",
        headRef: null,
        oldPath: "missing.txt",
        newPath: "missing.txt",
      })
      .pipe(Effect.flip);
    assert.strictEqual(missing._tag, "GitCommandError");
    assert.include(missing.message, "Could not resolve diff file 'missing.txt'");

    yield* fileSystem.writeFile(path.join(repo, "binary.dat"), Uint8Array.from([0, 1, 2]));
    const binary = yield* driver
      .getReviewDiffFileContents({
        cwd: repo,
        sourceKind: "working-tree",
        changeType: "new",
        baseRef: "HEAD",
        headRef: null,
        oldPath: "binary.dat",
        newPath: "binary.dat",
      })
      .pipe(Effect.flip);
    assert.strictEqual(binary._tag, "GitCommandError");
    assert.include(binary.message, "Cannot expand binary file 'binary.dat'");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver lists local and remote refs with upstream metadata", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-refs-" });
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    yield* runGit(repo, ["remote", "add", "origin", repo]);
    yield* runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    yield* runGit(repo, ["update-ref", "refs/remotes/origin/release", "HEAD"]);
    yield* runGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    yield* runGit(repo, ["switch", "-c", "feature/refs"]);

    const local = yield* driver.listRefs({
      cwd: repo,
      refKind: "local",
      includeMatchingRemoteRefs: true,
    });
    assert.strictEqual(
      local.refs.every((ref) => ref.isRemote !== true),
      true,
    );
    assert.strictEqual(local.refs.find((ref) => ref.name === "feature/refs")?.current, true);

    const remote = yield* driver.listRefs({
      cwd: repo,
      refKind: "remote",
      includeMatchingRemoteRefs: true,
    });
    assert.strictEqual(remote.hasPrimaryRemote, true);
    assert.deepInclude(
      remote.refs.find((ref) => ref.name === "origin/main"),
      {
        name: "origin/main",
        isRemote: true,
        remoteName: "origin",
        isDefault: true,
      },
    );
    assert.strictEqual(
      remote.refs.some((ref) => ref.name === "origin/release"),
      true,
    );

    const deduplicated = yield* driver.listRefs({ cwd: repo });
    assert.strictEqual(
      deduplicated.refs.some((ref) => ref.name === "origin/main"),
      false,
    );
    assert.strictEqual(
      deduplicated.refs.some((ref) => ref.name === "origin/release"),
      true,
    );
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver checks out the requested commit and records the worktree base", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-git-worktree-base-",
    });
    const repo = path.join(fixtureRoot, "repo");
    const worktreePath = path.join(fixtureRoot, "worktree");
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(repo, ["init", "--initial-branch=main"]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "base\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial"]);
    const requestedCommit = yield* readGit(repo, ["rev-parse", "HEAD"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), "advanced\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Advance"]);
    yield* runGit(repo, ["remote", "add", "origin", repo]);
    yield* runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    yield* driver.createWorktree({
      cwd: repo,
      path: worktreePath,
      refName: requestedCommit,
      newRefName: "feature/from-base",
      baseRefName: "origin/main",
    });

    assert.strictEqual(yield* readGit(worktreePath, ["rev-parse", "HEAD"]), requestedCommit);
    assert.strictEqual(
      yield* readGit(worktreePath, ["config", "--get", "branch.feature/from-base.gh-merge-base"]),
      "main",
    );
    yield* driver.removeWorktree({ cwd: repo, path: worktreePath, force: true });
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver switchRef resolves remote-tracking refs to local branches", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-git-switch-ref-",
    });
    const upstream = path.join(fixtureRoot, "upstream");
    const repo = path.join(fixtureRoot, "repo");
    yield* fileSystem.makeDirectory(upstream);
    yield* fileSystem.makeDirectory(repo);
    yield* runGit(upstream, ["init", "--initial-branch=main"]);
    yield* runGit(upstream, ["config", "user.email", "test@test.com"]);
    yield* runGit(upstream, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(upstream, "README.md"), "base\n");
    yield* runGit(upstream, ["add", "README.md"]);
    yield* runGit(upstream, ["commit", "-m", "Initial"]);
    yield* runGit(upstream, ["branch", "feature/only-remote"]);
    yield* runGit(upstream, ["branch", "feature/existing-local"]);
    yield* runGit(upstream, ["branch", "feature/twin"]);
    yield* runGit(upstream, ["branch", "feature/untracked"]);
    yield* runGit(repo, ["clone", upstream, "."]);
    yield* runGit(repo, ["config", "user.email", "test@test.com"]);
    yield* runGit(repo, ["config", "user.name", "Test"]);
    yield* runGit(repo, ["branch", "feature/existing-local", "origin/feature/existing-local"]);
    yield* runGit(repo, ["branch", "twin-alias", "origin/feature/twin"]);
    yield* runGit(repo, ["branch", "feature/untracked", "origin/feature/untracked"]);
    yield* runGit(repo, ["branch", "--unset-upstream", "feature/untracked"]);

    // Remote-only ref: creates and checks out a local branch tracking it.
    const created = yield* driver.switchRef({ cwd: repo, refName: "origin/feature/only-remote" });
    assert.strictEqual(created.refName, "feature/only-remote");
    assert.strictEqual(
      yield* readGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      "origin/feature/only-remote",
    );

    // Remote ref tracked by a differently-named local branch: checks that out.
    const alias = yield* driver.switchRef({ cwd: repo, refName: "origin/feature/twin" });
    assert.strictEqual(alias.refName, "twin-alias");

    // Local twin exists but does not track the remote ref: upstream checks out
    // the remote ref directly (detached HEAD, so no branch name comes back).
    const untracked = yield* driver.switchRef({ cwd: repo, refName: "origin/feature/untracked" });
    assert.strictEqual(untracked.refName, null);

    // Remote ref tracked by a same-named local branch: checks that out.
    const existing = yield* driver.switchRef({
      cwd: repo,
      refName: "origin/feature/existing-local",
    });
    assert.strictEqual(existing.refName, "feature/existing-local");
    assert.strictEqual(
      yield* readGit(repo, ["symbolic-ref", "--short", "HEAD"]),
      "feature/existing-local",
    );

    // Plain local ref: unchanged behavior.
    const local = yield* driver.switchRef({ cwd: repo, refName: "main" });
    assert.strictEqual(local.refName, "main");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);
