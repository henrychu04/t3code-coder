// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { describe, expect, it, vi } from "@effect/vitest";
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

  describe("search", () => {
    it.effect("uses fuzzy path search and applies file masks before limiting results", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-entry-search-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "src"));
        yield* fileSystem.writeFileString(path.join(root, "src", "WorkspaceSearchIndex.ts"), "");
        yield* fileSystem.writeFileString(
          path.join(root, "src", "WorkspaceSearchIndex.test.ts"),
          "",
        );
        yield* fileSystem.writeFileString(path.join(root, "src", "unrelated.tsx"), "");

        const fuzzy = yield* entries.search({
          cwd: root,
          query: "wspcsearch",
          limit: 10,
          kind: "file",
        });
        const masked = yield* entries.search({
          cwd: root,
          query: "",
          limit: 10,
          kind: "file",
          fileMask: "*.tsx",
        });

        expect(fuzzy.entries.map((entry) => entry.path)).toContain("src/WorkspaceSearchIndex.ts");
        expect(masked.entries).toEqual([{ path: "src/unrelated.tsx", kind: "file" }]);
      }),
    );

    it.effect("compiles IntelliJ file masks into native FFF constraints", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-entry-native-mask-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "src"));
        yield* fileSystem.writeFileString(path.join(root, "src", "App.ts"), "");
        yield* fileSystem.writeFileString(path.join(root, "src", "App.test.ts"), "");
        yield* fileSystem.writeFileString(path.join(root, "src", "App.tsx"), "");
        const fileSearch = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(FileFinder.prototype, "fileSearch")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );

        const result = yield* entries.search({
          cwd: root,
          query: "",
          limit: 10,
          kind: "file",
          fileMask: "*.ts,*.tsx,!*.test.ts",
        });

        expect(fileSearch).toHaveBeenCalledWith("{**/*.ts,**/*.tsx} !**/*.test.ts", {
          pageSize: 25_002,
        });
        expect(result.entries).toEqual([
          { path: "src/App.ts", kind: "file" },
          { path: "src/App.tsx", kind: "file" },
        ]);
      }),
    );
  });

  describe("searchText", () => {
    it.effect("returns native content matches with exact ranges", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-content-search-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "src"));
        yield* fileSystem.writeFileString(
          path.join(root, "src", "one.ts"),
          "alpha\nNeedle here\nneedle again\n",
        );

        const result = yield* entries.searchText({
          cwd: root,
          query: "needle",
          limit: 20,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/one.ts", 2],
          ["src/one.ts", 3],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 0, end: 6 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("applies IntelliJ masks to native content search", () =>
      Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-coder-content-mask-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "src"));
        yield* fileSystem.writeFileString(path.join(root, "src", "one.ts"), "needle\n");
        yield* fileSystem.writeFileString(path.join(root, "src", "one.test.ts"), "needle\n");
        yield* fileSystem.writeFileString(path.join(root, "README.md"), "needle\n");

        const result = yield* entries.searchText({
          cwd: root,
          query: "needle",
          fileMask: "*.ts,!*.test.ts",
          limit: 20,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches.map((match) => match.path)).toEqual(["src/one.ts"]);
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
