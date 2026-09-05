// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const EntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(EntriesLayer),
);
const TestLayer = ProjectLayer.pipe(
  Layer.provideMerge(EntriesLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-coder-workspace-files-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

it.layer(TestLayer)("WorkspaceFileSystem", (it) => {
  describe("readFile", () => {
    it.effect("reads bounded UTF-8 files with a revision", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* files.readFile({ cwd, relativePath: "src/index.ts" });

        expect(result).toMatchObject({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
        expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
      }),
    );

    it.effect("rejects traversal and symlinks outside the workspace", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "secret.txt", "secret\n");
        yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(cwd, "secret.txt"));

        const traversal = yield* files
          .readFile({ cwd, relativePath: "../secret.txt" })
          .pipe(Effect.flip);
        const symlink = yield* files
          .readFile({ cwd, relativePath: "secret.txt" })
          .pipe(Effect.flip);

        expect(traversal).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(symlink).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
      }),
    );

    it.effect("rejects binary files without exposing contents", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62])),
        );

        const error = yield* files.readFile({ cwd, relativePath: "asset.bin" }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("rejects invalid UTF-8 text", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(path.join(cwd, "invalid.txt"), Uint8Array.from([0xc3, 0x28])),
        );

        const error = yield* files.readFile({ cwd, relativePath: "invalid.txt" }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
      }),
    );

    it.effect("truncates files over 1 MiB", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "a".repeat(1024 * 1024 + 1));

        const result = yield* files.readFile({ cwd, relativePath: "large.txt" });

        expect(result.byteLength).toBe(1024 * 1024 + 1);
        expect(result.contents).toHaveLength(1024 * 1024);
        expect(result.truncated).toBe(true);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("atomically replaces an existing file when its revision matches", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "before\n");
        const before = yield* files.readFile({ cwd, relativePath: "README.md" });

        const saved = yield* files.writeFile({
          cwd,
          relativePath: "README.md",
          contents: "after\n",
          expectedRevision: before.revision,
        });
        const after = yield* files.readFile({ cwd, relativePath: "README.md" });

        expect(after.contents).toBe("after\n");
        expect(saved.revision).toBe(after.revision);
        expect(saved.revision).not.toBe(before.revision);
      }),
    );

    it.effect("allows only one concurrent write for the same revision", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "shared.txt", "original");
        const initial = yield* files.readFile({ cwd, relativePath: "shared.txt" });
        const results = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            files
              .writeFile({
                cwd,
                relativePath: "shared.txt",
                expectedRevision: initial.revision,
                contents: `writer ${index}`,
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failures = results.filter((result) => result._tag === "Failure");
        expect(failures).toHaveLength(7);
        for (const result of failures)
          expect(result.failure).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileStaleError);
      }),
    );

    it.effect("rejects a stale write and preserves the newer contents", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "initial\n");
        const initial = yield* files.readFile({ cwd, relativePath: "README.md" });
        yield* writeTextFile(cwd, "README.md", "external\n");

        const error = yield* files
          .writeFile({
            cwd,
            relativePath: "README.md",
            contents: "editor\n",
            expectedRevision: initial.revision,
          })
          .pipe(Effect.flip);
        const contents = yield* Effect.promise(() =>
          NodeFSP.readFile(path.join(cwd, "README.md"), "utf8"),
        );

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileStaleError);
        expect(contents).toBe("external\n");
      }),
    );
  });
});

it.layer(TestLayer)("write cancellation", (it) => {
  it.effect("does not let an interrupted save overwrite a newer successful save", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const refreshSpy = vi.spyOn(yield* WorkspaceEntries.WorkspaceEntries, "refresh");
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "test.txt", "original");
      const original = yield* files.readFile({ cwd, relativePath: "test.txt" });
      let started!: () => void;
      let release!: () => void;
      let finished!: () => void;
      const atRename = new Promise<void>((resolve) => {
        started = resolve;
      });
      const releaseRename = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstFinished = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const rename = (yield* Effect.promise(() =>
        vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
      )).rename;
      let calls = 0;
      const spy = vi.spyOn(NodeFSP, "rename").mockImplementation(async (from, to) => {
        if (++calls === 1) {
          started();
          await releaseRename;
          await rename(from, to);
          finished();
        } else await rename(from, to);
      });
      try {
        const first = yield* files
          .writeFile({
            cwd,
            relativePath: "test.txt",
            contents: "old save",
            expectedRevision: original.revision,
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => atRename);
        let interruptionFinished = false;
        const interrupt = yield* Fiber.interrupt(first).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              interruptionFinished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
        expect(interruptionFinished).toBe(false);
        const second = yield* files
          .writeFile({
            cwd,
            relativePath: "test.txt",
            contents: "new save",
            expectedRevision: original.revision,
          })
          .pipe(Effect.result, Effect.forkChild);
        release();
        yield* Fiber.join(interrupt);
        yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);
        expect(refreshSpy).toHaveBeenCalled();
        const secondResult = yield* Fiber.join(second);
        expect(secondResult._tag).toBe("Failure");
        if (secondResult._tag === "Failure")
          expect(secondResult.failure).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileStaleError);
        const current = yield* files.readFile({ cwd, relativePath: "test.txt" });
        yield* files.writeFile({
          cwd,
          relativePath: "test.txt",
          contents: "new save",
          expectedRevision: current.revision,
        });
        yield* Effect.promise(() => firstFinished);
        const final = yield* files.readFile({ cwd, relativePath: "test.txt" });
        expect(final.contents).toBe("new save");
      } finally {
        release();
        spy.mockRestore();
        refreshSpy.mockRestore();
      }
    }),
  );
});
