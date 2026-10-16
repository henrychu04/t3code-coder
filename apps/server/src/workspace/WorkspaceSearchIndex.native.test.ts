import * as NodeModule from "node:module";
// Coder: aliased beside Effect's `Result`, which the characterization test below uses.
import type { Result as FffResult } from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as NodePath from "node:path";
import * as Result from "effect/Result";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

function valueOf<T>(result: FffResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

it.effect("decodes native search and grep strings and keeps scores only through 200 results", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const basePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fff-native-" });
    const names = [
      ...Array.from({ length: 205 }, (_, index) => `file-${String(index).padStart(3, "0")}`),
      "日本語",
      "café",
      "emoji-🦊",
    ];
    const relativePaths = names.map((name) => `${name}/${name}.ts`);
    const content = "prefix marker-日本語🦊\n";
    yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.join(basePath, name));
          yield* fileSystem.writeFileString(path.join(basePath, name, `${name}.ts`), content);
        }),
      { concurrency: "unbounded" },
    );
    expect(requireForFff.resolve("@ff-labs/fff-node").replaceAll("\\", "/")).toMatch(
      /\/dist\/index\.js$/u,
    );
    const finder = yield* Effect.acquireRelease(
      Effect.sync(() =>
        valueOf(FileFinder.create({ basePath, disableWatch: true, disableMmapCache: true })),
      ),
      (finder) => Effect.sync(() => finder.destroy()),
    );
    expect(valueOf(yield* Effect.promise(() => finder.waitForIndexReady(10_000)))).toBe(true);

    const files200 = valueOf(finder.fileSearch("", { pageSize: 200 }));
    const files201 = valueOf(finder.fileSearch("", { pageSize: 201 }));
    expect(files200.items).toHaveLength(200);
    expect(files200.scores).toHaveLength(200);
    expect(files201.items).toHaveLength(201);
    expect(files201.scores).toEqual([]);
    expect(files201.items.slice(0, 200)).toEqual(files200.items);
    const files = valueOf(finder.fileSearch("", { pageSize: 1000 }));
    expect(files.items.map((item) => item.relativePath.normalize("NFC")).toSorted()).toEqual(
      relativePaths.toSorted(),
    );
    for (const item of files.items) {
      expect(item.fileName.normalize("NFC")).toBe(
        path.basename(item.relativePath).normalize("NFC"),
      );
      expect(item.size).toBe(Buffer.byteLength(content));
      expect(Number.isFinite(item.modified)).toBe(true);
    }
    const exact = valueOf(finder.fileSearch("日本語.ts", { pageSize: 1 }));
    expect(exact.items[0]?.fileName.normalize("NFC")).toBe("日本語.ts");
    expect(exact.scores[0]).toMatchObject({ exactMatch: true, matchType: "exact_filename" });

    const dirs200 = valueOf(finder.directorySearch("", { pageSize: 200 }));
    const dirs201 = valueOf(finder.directorySearch("", { pageSize: 201 }));
    expect(dirs200.scores).toHaveLength(200);
    expect(dirs201.items).toHaveLength(201);
    expect(dirs201.scores).toEqual([]);
    expect(dirs201.items.slice(0, 200)).toEqual(dirs200.items);
    const directories = valueOf(finder.directorySearch("", { pageSize: 1000 }));
    expect(
      directories.items
        .map((item) => item.relativePath.normalize("NFC"))
        .filter(Boolean)
        .toSorted(),
    ).toEqual(names.map((name) => `${name}/`).toSorted());

    const mixed200 = valueOf(finder.mixedSearch("", { pageSize: 200 }));
    const mixed201 = valueOf(finder.mixedSearch("", { pageSize: 201 }));
    expect(mixed200.scores).toHaveLength(200);
    expect(mixed201.items).toHaveLength(201);
    expect(mixed201.scores).toEqual([]);
    expect(mixed201.items.slice(0, 200)).toEqual(mixed200.items);
    const mixed = valueOf(finder.mixedSearch("", { pageSize: 1000 }));
    expect(mixed.items.filter((item) => item.type === "file").map(({ item }) => item)).toEqual(
      files.items,
    );
    expect(mixed.items.filter((item) => item.type === "directory").map(({ item }) => item)).toEqual(
      directories.items,
    );

    const grep = valueOf(finder.grep("marker", { mode: "plain", pageSize: 1000 }));
    expect(grep.items.map((item) => item.relativePath.normalize("NFC")).toSorted()).toEqual(
      relativePaths.toSorted(),
    );
    for (const item of grep.items) {
      expect(item.fileName.normalize("NFC")).toBe(
        path.basename(item.relativePath).normalize("NFC"),
      );
      expect(item.lineContent).toBe(content.trimEnd());
      expect(item.lineNumber).toBe(1);
      expect(item.col).toBe(7);
      expect(item.matchRanges).toEqual([[7, 13]]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Coder: characterization of the helper's bounded content search over the native library. Run
// this suite on the supported Linux x86-64 helper target too.
it.effect("native content search excludes binary, oversized, and escaped files and paginates", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => FS.mkdtemp(NodePath.join(OS.tmpdir(), "t3-fff-native-"))),
      (root) => Effect.promise(() => FS.rm(root, { recursive: true, force: true })),
    );
    const root = NodePath.join(yield* Effect.promise(() => FS.realpath(fixture)), "project");
    yield* Effect.promise(async () => {
      await FS.mkdir(root);
      await FS.writeFile(NodePath.join(root, "text.txt"), "needle one\nneedle two\nneedle three\n");
      await FS.writeFile(NodePath.join(root, "binary.bin"), Buffer.from("needle\0binary"));
      await FS.writeFile(NodePath.join(root, "large.txt"), "needle\n" + "x".repeat(11 * 1024 * 1024));
      await FS.writeFile(NodePath.join(fixture, "outside.txt"), "needle outside");
      await FS.symlink(NodePath.join(fixture, "outside.txt"), NodePath.join(root, "escape.txt"));
    });
    const index = yield* WorkspaceSearchIndex.make(root, "content");
    const input = {
      query: "needle",
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
      limit: 1,
    };
    let cursor: string | undefined;
    const lines: number[] = [];
    for (let page = 0; page < 10; page++) {
      const result = yield* index.searchText({ ...input, ...(cursor ? { cursor } : {}) });
      for (const match of result.matches) {
        expect(match.path).toBe("text.txt");
        lines.push(match.lineNumber);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(lines.toSorted()).toEqual([1, 2, 3]);
    expect(cursor).toBeUndefined();
    const firstPage = yield* index.searchText(input);
    expect(firstPage.nextCursor).toBeDefined();
    const mismatched = yield* index
      .searchText({ ...input, query: "different", cursor: firstPage.nextCursor! })
      .pipe(Effect.result);
    expect(Result.isFailure(mismatched)).toBe(true);
    yield* index.refresh();
    const expired = yield* index
      .searchText({ ...input, cursor: firstPage.nextCursor! })
      .pipe(Effect.result);
    expect(Result.isFailure(expired)).toBe(true);
    const invalid = yield* index.searchText({ ...input, query: "(", useRegex: true });
    expect(invalid.matches).toEqual([]);
    expect(invalid.regexFallbackError).toBe("Invalid regular expression.");
  }),
);
