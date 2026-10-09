// Coder: artifact retention and worktree safety for the workspace helper's storage cleanup.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Config from "./config.ts";
import * as Workflow from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import * as Cleanup from "./storageCleanup.ts";
import * as Terminals from "./terminal/Manager.ts";
import * as Git from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

interface Snapshot {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}

const emptySnapshot: Snapshot = { projects: [], threads: [] };

function fixtures(snapshot: Snapshot = emptySnapshot) {
  return Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.succeed({
          threads: options?.location === "archive" ? [] : snapshot.threads,
        } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Effect.succeed(snapshot.projects),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.never,
    }),
    Layer.mock(Workflow.GitManager)({
      invalidateStatus: () => Effect.void,
    }),
    Layer.mock(Terminals.TerminalManager)({
      subscribeMetadata: () => Effect.succeed(() => {}),
    }),
    SqlitePersistence.layerMemory,
  );
}

const base = Git.layer.pipe(
  Layer.provideMerge(
    Layer.effect(
      Config.ServerConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-test-" });
        const baseDir = yield* fs.realPath(directory);
        const paths = yield* Config.deriveServerPaths(baseDir);
        yield* Config.ensureServerDirectories(paths);
        return Config.ServerConfig.of({ cwd: baseDir, baseDir, ...paths });
      }),
    ),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runCleanup = (snapshot: Snapshot, settings?: Parameters<typeof Settings.layerTest>[0]) =>
  Effect.gen(function* () {
    // Built into the test's scope: the sweep queries the database after `make` returns.
    const context = yield* Layer.build(
      Layer.merge(fixtures(snapshot), Settings.layerTest(settings)),
    );
    const cleanup = yield* Cleanup.make.pipe(Effect.provideContext(context));
    yield* cleanup.start();
    yield* Effect.yieldNow;
    yield* cleanup.drain;
  });

it.effect(
  "retention is off by default and never removes submitted images or workspace source images",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.screenshotArtifactsDir, { recursive: true });
      const artifact = NodePath.join(config.screenshotArtifactsDir, "old.png");
      yield* fs.writeFileString(artifact, "saved image");
      yield* runCleanup(emptySnapshot);
      expect(yield* fs.exists(artifact)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "cleans expired saved artifacts and rotated logs while preserving recent files, sources, attachments and symlinks",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const now = yield* Clock.currentTimeMillis;
      const old = new Date(now - 10 * 86_400_000);
      yield* fs.makeDirectory(config.screenshotArtifactsDir, { recursive: true });
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      const paths = {
        expired: NodePath.join(config.screenshotArtifactsDir, "old.png"),
        recent: NodePath.join(config.screenshotArtifactsDir, "recent.png"),
        attachment: NodePath.join(config.attachmentsDir, "submitted.png"),
        source: NodePath.join(config.baseDir, "source.png"),
        rotated: NodePath.join(config.logsDir, "server.log.1"),
        current: NodePath.join(config.logsDir, "server.log"),
      };
      for (const [name, path] of Object.entries(paths)) {
        yield* fs.writeFileString(path, name);
        const time = name === "recent" ? new Date(now) : old;
        yield* Effect.promise(() => NodeFS.utimes(path, time, time));
      }
      const link = NodePath.join(config.screenshotArtifactsDir, "linked.png");
      yield* fs.symlink(paths.source, link);
      yield* runCleanup(emptySnapshot, {
        storageCleanup: { browserArtifactsAfterDays: 3, logsAfterDays: 3 },
      });
      expect(yield* fs.exists(paths.expired)).toBe(false);
      expect(yield* fs.exists(paths.rotated)).toBe(false);
      for (const path of [paths.recent, paths.attachment, paths.source, paths.current, link])
        expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "removes an expired idle managed worktree but preserves active, dirty, shared and ignored-file checkouts",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const root = NodePath.join(config.baseDir, "project");
      yield* fs.makeDirectory(root);
      const run = (cwd: string, args: string[]) =>
        git.execute({ cwd, args, operation: "cleanup.test" });
      yield* run(root, ["init"]);
      yield* run(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      const threads: OrchestrationV2ThreadShell[] = [];
      const createdAt = DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 10 * 86_400_000);
      yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
      for (const name of ["idle", "active", "dirty", "shared", "ignored"]) {
        const path = NodePath.join(config.worktreesDir, name);
        yield* run(root, ["worktree", "add", "-b", name, path]);
        const thread = {
          id: ThreadId.make(name),
          projectId: ProjectId.make("project"),
          branch: name,
          worktreePath: path,
          status: name === "active" ? "running" : "idle",
          activeRunId: name === "active" ? RunId.make("run-active") : null,
          pendingBackgroundTasks: [],
          pendingRuntimeRequest: null,
          latestUserMessageAt: null,
          latestRunRequestedAt: null,
          latestRunStartedAt: null,
          latestRunCompletedAt: null,
          createdAt,
          updatedAt: createdAt,
        } as unknown as OrchestrationV2ThreadShell;
        threads.push(thread);
        if (name === "dirty")
          yield* fs.writeFileString(NodePath.join(path, "untracked.txt"), "keep");
        if (name === "ignored") {
          yield* fs.writeFileString(NodePath.join(root, ".git", "info", "exclude"), "secret.txt\n");
          yield* fs.writeFileString(NodePath.join(path, "secret.txt"), "keep");
        }
        if (name === "shared") threads.push({ ...thread, id: ThreadId.make("shared-2") });
      }
      const snapshot: Snapshot = {
        projects: [
          { id: ProjectId.make("project"), workspaceRoot: root } as OrchestrationProjectShell,
        ],
        threads,
      };
      yield* runCleanup(snapshot, { storageCleanup: { worktreeAfterDays: 3 } });
      expect(yield* fs.exists(NodePath.join(config.worktreesDir, "idle"))).toBe(false);
      for (const name of ["active", "dirty", "shared", "ignored"])
        expect(yield* fs.exists(NodePath.join(config.worktreesDir, name))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(base)),
);
