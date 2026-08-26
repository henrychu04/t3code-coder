import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as NodeZlib from "node:zlib";

import { MAX_REVIEW_DIFF_FILE_BYTES } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
}) {
  return ReviewService.layer.pipe(
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
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
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
          .getDiffFileContents({
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
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
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
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () => Effect.succeed(contents),
          }),
        ),
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
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed({ kind: "git" } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            getReviewDiffFileContents: () => Effect.succeed({ oldContents: "", newContents: "" }),
          }),
        ),
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
        assert.notStrictEqual(anchor.newFile, null);
        if (anchor.newFile === null) return;

        const failure = yield* review
          .openDiffFileContents({ ...input, changeType: "change" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "GitCommandError");

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
