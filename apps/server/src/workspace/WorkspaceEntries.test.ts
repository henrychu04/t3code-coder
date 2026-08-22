// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = WorkspaceEntries.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("WorkspaceEntries", (it) => {
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
        yield* Effect.promise(() => NodeFS.symlink(path.join(root, "alpha"), path.join(root, "link")));

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

        const error = yield* entries.listDirectories({ path: "relative/project" }).pipe(Effect.flip);

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
