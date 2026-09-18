import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Cleanup from "./storageCleanup.ts";
import * as Snapshots from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Engine from "./orchestration/Services/OrchestrationEngine.ts";
import * as Deletion from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as Providers from "./provider/Services/ProviderService.ts";
import * as Terminals from "./terminal/Manager.ts";
import * as Git from "./vcs/GitVcsDriver.ts";
import * as Workflow from "./git/GitWorkflowService.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const emptySnapshot = { projects: [], threads: [] } as unknown as OrchestrationShellSnapshot;
function fixtures(snapshot = emptySnapshot) {
  return Layer.mergeAll(
    Layer.succeed(Snapshots.ProjectionSnapshotQuery, {
      getShellSnapshot: () => Effect.succeed(snapshot),
      getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot),
      getDeletedWorktreeThreads: () => Effect.succeed([]),
    } as unknown as Snapshots.ProjectionSnapshotQueryShape),
    Layer.succeed(Engine.OrchestrationEngineService, {
      subscribeDomainEvents: Effect.succeed(Stream.never),
    } as unknown as Engine.OrchestrationEngineShape),
    Layer.succeed(Deletion.ThreadDeletionReactor, {} as Deletion.ThreadDeletionReactor["Service"]),
    Layer.succeed(Providers.ProviderService, {} as Providers.ProviderService["Service"]),
    Layer.succeed(Workflow.GitWorkflowService, {
      invalidateStatus: () => Effect.void,
    } as unknown as Workflow.GitWorkflowService["Service"]),
    Layer.succeed(Terminals.TerminalManager, {
      subscribeMetadata: () => Effect.succeed(() => {}),
    } as unknown as Terminals.TerminalManager["Service"]),
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

it.effect(
  "retention is off by default and never removes submitted images or workspace source images",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.screenshotArtifactsDir, { recursive: true });
      const artifact = NodePath.join(config.screenshotArtifactsDir, "old.png");
      yield* fs.writeFileString(artifact, "saved image");
      const cleanup = yield* Cleanup.make.pipe(
        Effect.provide(fixtures()),
        Effect.provide(Settings.layerTest()),
      );
      yield* cleanup.start();
      yield* Effect.yieldNow;
      yield* cleanup.drain;
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
        yield* Effect.promise(() =>
          NodeFS.utimes(
            path,
            name === "recent" ? new Date(now) : old,
            name === "recent" ? new Date(now) : old,
          ),
        );
      }
      const link = NodePath.join(config.screenshotArtifactsDir, "linked.png");
      yield* fs.symlink(paths.source, link);
      const cleanup = yield* Cleanup.make.pipe(
        Effect.provide(fixtures()),
        Effect.provide(
          Settings.layerTest({
            storageCleanup: { browserArtifactsAfterDays: 3, logsAfterDays: 3 },
          }),
        ),
      );
      yield* cleanup.start();
      yield* Effect.yieldNow;
      yield* cleanup.drain;
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
      const threads: OrchestrationThreadShell[] = [];
      const now = yield* Clock.currentTimeMillis;
      for (const name of ["idle", "active", "dirty", "shared", "ignored"]) {
        const path = NodePath.join(config.worktreesDir, name);
        yield* run(root, ["worktree", "add", "-b", name, path]);
        const thread = {
          id: ThreadId.make(name),
          projectId: ProjectId.make("project"),
          branch: name,
          worktreePath: path,
          session: name === "active" ? { status: "ready" } : null,
          latestTurn: null,
          latestUserMessageAt: null,
          createdAt: new Date(now - 10 * 86_400_000).toISOString(),
          backgroundLiveness: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        } as unknown as OrchestrationThreadShell;
        threads.push(thread);
        if (name === "dirty")
          yield* fs.writeFileString(NodePath.join(path, "untracked.txt"), "keep");
        if (name === "ignored") {
          yield* fs.writeFileString(NodePath.join(root, ".git", "info", "exclude"), "secret.txt\n");
          yield* fs.writeFileString(NodePath.join(path, "secret.txt"), "keep");
        }
        if (name === "shared") threads.push({ ...thread, id: ThreadId.make("shared-2") });
      }
      const snapshot = {
        projects: [{ id: ProjectId.make("project"), workspaceRoot: root }],
        threads,
      } as unknown as OrchestrationShellSnapshot;
      const cleanup = yield* Cleanup.make.pipe(
        Effect.provide(fixtures(snapshot)),
        Effect.provide(Settings.layerTest({ storageCleanup: { worktreeAfterDays: 3 } })),
      );
      yield* cleanup.start();
      yield* Effect.yieldNow;
      yield* cleanup.drain;
      expect(yield* fs.exists(NodePath.join(config.worktreesDir, "idle"))).toBe(false);
      for (const name of ["active", "dirty", "shared", "ignored"])
        expect(yield* fs.exists(NodePath.join(config.worktreesDir, name))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(base)),
);
