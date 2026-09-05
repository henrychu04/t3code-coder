// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

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
