import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeZlib from "node:zlib";

import { MAX_REVIEW_DIFF_FILE_BYTES, ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  /** What `git worktree list` reports for every project. */
  readonly gitWorktrees?: ReadonlyArray<string>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .openDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      // A child whose name starts with `..` is still inside.
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      // Checkouts outside every managed folder, as `git worktree add ../feature` makes.
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      // A client can set a thread's path to any folder; git doesn't list this one.
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            makeLayer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                // A relative path would resolve against the server's own cwd.
                { worktreePath: "t3-review-relative" },
                // A filesystem root would make every folder look bound.
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serves immutable diff file snapshots in bounded chunks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const contents = { oldContents: "before\n", newContents: "after\n" };
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({
            contains: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () => Effect.succeed(contents),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const opened = yield* review.openDiffFileContents({
          cwd: workspaceRoot,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "file.ts",
          newPath: "file.ts",
        });
        assert.strictEqual(opened._tag, "opened");
        if (opened._tag !== "opened") return "";
        assert.notStrictEqual(opened.oldFile, null);
        if (opened.oldFile === null) return "";
        const first = yield* review.readDiffFileChunk({
          snapshotId: opened.oldFile.snapshotId,
          offset: 0,
          limit: 3,
        });
        assert.strictEqual(first.encoding, "base64");
        assert.strictEqual(first.nextOffset, 3);
        const second = yield* review.readDiffFileChunk({
          snapshotId: opened.oldFile.snapshotId,
          offset: first.nextOffset ?? 0,
          limit: 512 * 1024,
        });
        const decode = (chunk: typeof first) => {
          const encoded = Buffer.from(chunk.dataBase64, "base64");
          const decoded = chunk.encoding === "gzip-base64" ? NodeZlib.gunzipSync(encoded) : encoded;
          assert.strictEqual(decoded.byteLength, chunk.decodedBytes);
          return decoded;
        };
        return Buffer.concat([decode(first), decode(second)]).toString("utf8");
      }).pipe(Effect.provide(layer));

      assert.strictEqual(result, contents.oldContents);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("compresses repetitive diff chunks when gzip is smaller", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const contents = "repeated source line\n".repeat(1_000);
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({
            contains: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () =>
              Effect.succeed({ oldContents: contents, newContents: contents }),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      const chunk = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const opened = yield* review.openDiffFileContents({
          cwd: workspaceRoot,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "file.ts",
          newPath: "file.ts",
        });
        assert.strictEqual(opened._tag, "opened");
        if (opened._tag !== "opened") return null;
        assert.notStrictEqual(opened.oldFile, null);
        if (opened.oldFile === null) return null;
        return yield* review.readDiffFileChunk({
          snapshotId: opened.oldFile.snapshotId,
          offset: 0,
          limit: 512 * 1024,
        });
      }).pipe(Effect.provide(layer));

      assert.notStrictEqual(chunk, null);
      if (chunk === null) return;
      assert.strictEqual(chunk.encoding, "gzip-base64");
      assert.strictEqual(chunk.decodedBytes, Buffer.byteLength(contents));
      assert.ok(Buffer.from(chunk.dataBase64, "base64").byteLength < chunk.decodedBytes);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unknown and out-of-range snapshot reads but permits the exact end", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({
            contains: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () =>
              Effect.succeed({ oldContents: "abc", newContents: "def" }),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const opened = yield* review.openDiffFileContents({
          cwd: workspaceRoot,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "file.ts",
          newPath: "file.ts",
        });
        assert.strictEqual(opened._tag, "opened");
        if (opened._tag !== "opened") return;
        assert.notStrictEqual(opened.oldFile, null);
        if (opened.oldFile === null) return;

        const end = yield* review.readDiffFileChunk({
          snapshotId: opened.oldFile.snapshotId,
          offset: opened.oldFile.totalBytes,
          limit: 1,
        });
        assert.deepStrictEqual(end, {
          snapshotId: opened.oldFile.snapshotId,
          offset: opened.oldFile.totalBytes,
          totalBytes: opened.oldFile.totalBytes,
          encoding: "base64",
          decodedBytes: 0,
          dataBase64: "",
          nextOffset: null,
        });

        const outOfRange = yield* review
          .readDiffFileChunk({
            snapshotId: opened.oldFile.snapshotId,
            offset: opened.oldFile.totalBytes + 1,
            limit: 1,
          })
          .pipe(Effect.flip);
        assert.strictEqual(outOfRange._tag, "GitCommandError");
        if (outOfRange._tag !== "GitCommandError") return;
        assert.match(outOfRange.detail, /outside the snapshot/);

        const unknown = yield* review
          .readDiffFileChunk({ snapshotId: "missing", offset: 0, limit: 1 })
          .pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "GitCommandError");
        if (unknown._tag !== "GitCommandError") return;
        assert.match(unknown.detail, /expired/);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds zero-byte snapshots by entry count", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({
            contains: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () => Effect.succeed({ oldContents: "", newContents: "" }),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        let firstSnapshotId: string | null = null;
        for (let index = 0; index <= 256; index += 1) {
          const opened = yield* review.openDiffFileContents({
            cwd: workspaceRoot,
            sourceKind: "working-tree",
            changeType: "new",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: `file-${index}.ts`,
          });
          assert.strictEqual(opened._tag, "opened");
          if (opened._tag !== "opened") continue;
          assert.notStrictEqual(opened.newFile, null);
          firstSnapshotId ??= opened.newFile?.snapshotId ?? null;
        }
        assert.notStrictEqual(firstSnapshotId, null);
        if (firstSnapshotId === null) return;

        const evicted = yield* review
          .readDiffFileChunk({ snapshotId: firstSnapshotId, offset: 0, limit: 1 })
          .pipe(Effect.flip);
        assert.strictEqual(evicted._tag, "GitCommandError");
        if (evicted._tag !== "GitCommandError") return;
        assert.match(evicted.detail, /expired/);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a partially cached snapshot when its pair exceeds the limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      let readCount = 0;
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({
            contains: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () =>
              Effect.sync(() => {
                readCount += 1;
                switch (readCount) {
                  case 1:
                    return { oldContents: "", newContents: "anchor" };
                  case 2:
                    return {
                      oldContents: "o".repeat(MAX_REVIEW_DIFF_FILE_BYTES),
                      newContents: "n".repeat(MAX_REVIEW_DIFF_FILE_BYTES + 1),
                    };
                  default:
                    return {
                      oldContents: "",
                      newContents: "f".repeat(MAX_REVIEW_DIFF_FILE_BYTES),
                    };
                }
              }),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const input = {
          cwd: workspaceRoot,
          sourceKind: "working-tree" as const,
          baseRef: "HEAD",
          headRef: null,
          oldPath: "file.ts",
          newPath: "file.ts",
        };
        const anchor = yield* review.openDiffFileContents({
          ...input,
          changeType: "new",
        });
        assert.strictEqual(anchor._tag, "opened");
        if (anchor._tag !== "opened") return;
        assert.notStrictEqual(anchor.newFile, null);
        if (anchor.newFile === null) return;

        const tooLarge = yield* review.openDiffFileContents({ ...input, changeType: "change" });
        assert.deepStrictEqual(tooLarge, {
          _tag: "tooLarge",
          path: "file.ts",
          maxBytes: MAX_REVIEW_DIFF_FILE_BYTES,
        });

        yield* review.openDiffFileContents({ ...input, changeType: "new" });
        const chunk = yield* review.readDiffFileChunk({
          snapshotId: anchor.newFile.snapshotId,
          offset: 0,
          limit: 512 * 1024,
        });
        assert.strictEqual(Buffer.from(chunk.dataBase64, "base64").toString("utf8"), "anchor");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
