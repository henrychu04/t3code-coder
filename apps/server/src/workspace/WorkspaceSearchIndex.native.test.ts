// Native-library characterization. Run this suite on the supported Linux x86-64 helper target too.
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

it.effect("native content search excludes binary, oversized, and escaped files and paginates", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => FS.mkdtemp(Path.join(OS.tmpdir(), "t3-fff-native-"))),
      (root) => Effect.promise(() => FS.rm(root, { recursive: true, force: true })),
    );
    const root = Path.join(yield* Effect.promise(() => FS.realpath(fixture)), "project");
    yield* Effect.promise(async () => {
      await FS.mkdir(root);
      await FS.writeFile(Path.join(root, "text.txt"), "needle one\nneedle two\nneedle three\n");
      await FS.writeFile(Path.join(root, "binary.bin"), Buffer.from("needle\0binary"));
      await FS.writeFile(Path.join(root, "large.txt"), "needle\n" + "x".repeat(11 * 1024 * 1024));
      await FS.writeFile(Path.join(fixture, "outside.txt"), "needle outside");
      await FS.symlink(Path.join(fixture, "outside.txt"), Path.join(root, "escape.txt"));
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
