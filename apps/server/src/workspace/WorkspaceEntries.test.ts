// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const execFileAsync = promisify(execFile);

const TestLayer = WorkspaceEntries.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("WorkspaceEntries", (it) => {
  describe("list", () => {
    it.effect("lists files and their ancestor directories without reading contents", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-entry-list-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "src", "nested"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "src", "nested", "index.ts"), "");

        const result = yield* entries.list({ cwd: root });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "src", kind: "directory" },
            { path: "src/nested", kind: "directory" },
            { path: "src/nested/index.ts", kind: "file" },
          ]),
        );
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("omits tracked files that have been deleted from the working tree", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-entry-deleted-",
        });
        const presentPath = path.join(root, "present.txt");
        const deletedPath = path.join(root, "deleted.txt");
        yield* fileSystem.writeFileString(presentPath, "present");
        yield* fileSystem.writeFileString(deletedPath, "deleted");
        yield* Effect.promise(() => execFileAsync("git", ["init"], { cwd: root }));
        yield* Effect.promise(() => execFileAsync("git", ["add", "."], { cwd: root }));
        yield* fileSystem.remove(deletedPath);

        const result = yield* entries.list({ cwd: root });

        expect(result.entries).toContainEqual({ path: "present.txt", kind: "file" });
        expect(result.entries).not.toContainEqual({ path: "deleted.txt", kind: "file" });
      }),
    );
  });

  describe("listDirectories", () => {
    it.effect("lists immediate remote directories without reading file contents", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-directory-list-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "zeta"));
        yield* fileSystem.makeDirectory(path.join(root, "alpha"));
        yield* fileSystem.writeFileString(path.join(root, "README.md"), "not transferred");
        yield* Effect.promise(() =>
          NodeFS.symlink(path.join(root, "alpha"), path.join(root, "link")),
        );

        const result = yield* entries.listDirectories({ path: root });

        expect(result).toEqual({
          path: root,
          parentPath: path.dirname(root),
          directories: [
            { name: "alpha", path: path.join(root, "alpha") },
            { name: "link", path: path.join(root, "link") },
            { name: "zeta", path: path.join(root, "zeta") },
          ],
          truncated: false,
        });
      }),
    );

    it.effect("rejects relative browse paths", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;

        const error = yield* entries
          .listDirectories({ path: "relative/project" })
          .pipe(Effect.flip);

        expect(error.message).toContain("Failed to list directories");
      }),
    );

    it.effect("defaults to the workspace home directory", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;

        const result = yield* entries.listDirectories({});

        expect(result.path).toBe(NodeOS.homedir());
      }),
    );
  });
});
