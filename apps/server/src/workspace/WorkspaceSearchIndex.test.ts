// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  FileFinder,
  type GrepCursor,
  type GrepMatch,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => vi.restoreAllMocks());

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fff-search-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
);

function grepMatch(overrides?: Partial<GrepMatch>): GrepMatch {
  return {
    relativePath: "src/index.ts",
    fileName: "index.ts",
    gitStatus: "clean",
    size: 10,
    modified: 0,
    isBinary: false,
    totalFrecencyScore: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    lineNumber: 1,
    col: 0,
    byteOffset: 0,
    lineContent: "needle",
    matchRanges: [[0, 6]],
    ...overrides,
  };
}

function grepResult(items: GrepMatch[], nextCursor: GrepCursor | null = null): GrepResult {
  return {
    items,
    totalMatched: items.length,
    totalFilesSearched: 1,
    totalFiles: 1,
    filteredFileCount: 1,
    nextCursor,
  };
}

function mockFinder(overrides?: Partial<FileFinder>): FileFinder {
  return {
    destroy: vi.fn(),
    waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    ...overrides,
  } as unknown as FileFinder;
}

it.effect("creates separate lightweight and content-enabled index variants", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const create = vi
      .spyOn(FileFinder, "create")
      .mockReturnValueOnce({ ok: true, value: mockFinder() })
      .mockReturnValueOnce({ ok: true, value: mockFinder() });

    yield* Effect.scoped(WorkspaceSearchIndex.make(root, "paths"));
    yield* Effect.scoped(WorkspaceSearchIndex.make(root, "content"));

    expect(create).toHaveBeenNthCalledWith(1, {
      basePath: root,
      disableMmapCache: true,
      disableContentIndexing: true,
      aiMode: false,
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      basePath: root,
      disableMmapCache: true,
      disableContentIndexing: false,
      aiMode: false,
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    });
  }),
);

it.effect("uses native grep limits and converts UTF-8 byte ranges to string offsets", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "src/index.ts"), "é needle"));
    const grep = vi.fn((_query: string, _options?: GrepOptions) => ({
      ok: true as const,
      value: grepResult([grepMatch({ lineContent: "é needle", matchRanges: [[3, 9]], size: 9 })]),
    }));
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({ grep } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const result = yield* index.searchText({
      query: "needle",
      limit: 500,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.matches).toEqual([
      {
        path: "src/index.ts",
        lineNumber: 1,
        lineContent: "é needle",
        matchRanges: [{ start: 2, end: 8 }],
      },
    ]);
    const options = grep.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    expect(options).toMatchObject({
      mode: "plain",
      smartCase: true,
      maxFileSize: 10 * 1024 * 1024,
      maxMatchesPerFile: 100,
      pageSize: 500,
    });
    expect(options?.timeBudgetMs).toBeGreaterThan(0);
    expect(options?.timeBudgetMs).toBeLessThanOrEqual(250);
  }),
);

it.effect(
  "rejects untrusted paths, symlink escapes, binary matches, and invalid UTF-8 snippets",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
      const outside = yield* temporaryDirectory;
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outside, "secret.ts"), "needle"));
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(outside, "secret.ts"), NodePath.join(root, "src/link.ts")),
      );
      const grep = vi.fn(() => ({
        ok: true as const,
        value: grepResult([
          grepMatch({ relativePath: "../secret.ts" }),
          grepMatch({ relativePath: "/etc/passwd" }),
          grepMatch({ relativePath: "src/link.ts" }),
          grepMatch({ relativePath: "src/binary.ts", isBinary: true }),
          grepMatch({ relativePath: "src/invalid.ts", lineContent: "needle�" }),
        ]),
      }));
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({
        ok: true,
        value: mockFinder({ grep } as Partial<FileFinder>),
      });

      const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
      const result = yield* index.searchText({
        query: "needle",
        limit: 20,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });

      expect(result.matches).toEqual([]);
    }),
);

it.effect("reports invalid regex without returning native diagnostic text", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    const query = "authorization: Bearer secret-token(";
    const grep = vi.fn(() => ({
      ok: true as const,
      value: {
        ...grepResult([grepMatch()]),
        regexFallbackError: `invalid regex ${query}`,
      },
    }));
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({ grep } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const result = yield* index.searchText({
      query,
      limit: 20,
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    });

    expect(result.regexFallbackError).toBe("Invalid regular expression.");
    expect(result.matches).toEqual([]);
    expect(result.regexFallbackError).not.toContain("Bearer");
  }),
);

it.effect("discards malformed native ranges and line numbers", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "src/index.ts"), "needle"));
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({
        grep: vi.fn(() => ({
          ok: true as const,
          value: grepResult([
            grepMatch({ lineNumber: 0 }),
            grepMatch({ matchRanges: [[4, 2]] }),
            grepMatch({ matchRanges: [[0, 0]] }),
          ]),
        })),
      } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const result = yield* index.searchText({
      query: "needle",
      limit: 20,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.matches).toEqual([]);
  }),
);

it.effect("continues cursor pages after whole-word filtering", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "src/index.ts"), "needle"));
    const nextCursor = { __brand: "GrepCursor", _offset: 1 } as GrepCursor;
    const grep = vi.fn((_query: string, options?: GrepOptions) => ({
      ok: true as const,
      value: options?.cursor
        ? grepResult([grepMatch()], null)
        : grepResult([grepMatch({ lineContent: "needleSuffix" })], nextCursor),
    }));
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({ grep } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const result = yield* index.searchText({
      query: "needle",
      limit: 1,
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
    });

    expect(result.matches).toHaveLength(1);
    expect(grep).toHaveBeenCalledTimes(2);
    expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
  }),
);

it.effect("sanitizes native search diagnostics", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    const secret = "authorization: Bearer secret-token";
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({
        grep: vi.fn(() => {
          throw new Error(`${secret} at ${realRoot}`);
        }),
      } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const error = yield* Effect.flip(
      index.searchText({
        query: secret,
        limit: 20,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      }),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexSearchFailed",
      queryLength: secret.length,
      pageSize: 20,
      reason: "FileFinder.grep threw unexpectedly.",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(realRoot);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("cwd");
  }),
);

it.effect("enforces post-validation result and per-file limits", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "src/index.ts"), "needle"));
    const items = Array.from({ length: 101 }, (_, index) => grepMatch({ lineNumber: index + 1 }));
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: true,
      value: mockFinder({
        grep: vi.fn(() => ({ ok: true as const, value: grepResult(items) })),
      } as Partial<FileFinder>),
    });

    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const result = yield* index.searchText({
      query: "needle",
      limit: 500,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
  }),
);

it.effect("rejects an in-flight search when its index is refreshed during validation", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(root, "file.txt"), "needle\nneedle"),
    );
    let refresh: (() => Promise<void>) | undefined;
    let refreshed: Promise<void> | undefined;
    let refreshOnSearch = true;
    vi.spyOn(FileFinder, "create").mockReturnValue({
      ok: true,
      value: mockFinder({
        scanFiles: () => ({ ok: true, value: undefined }),
        grep: () => {
          // Refresh overlaps the asynchronous path validation after the native read.
          if (refreshOnSearch) {
            refreshOnSearch = false;
            queueMicrotask(() => {
              refreshed = refresh!();
            });
          }
          return {
            ok: true,
            value: grepResult([
              grepMatch({ relativePath: "file.txt", lineNumber: 1 }),
              grepMatch({ relativePath: "file.txt", lineNumber: 2 }),
            ]),
          };
        },
      } as Partial<FileFinder>),
    });
    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    refresh = () => Effect.runPromise(index.refresh());
    const input = {
      query: "needle",
      limit: 1,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    };
    const first = yield* index.searchText(input).pipe(Effect.result);
    yield* Effect.promise(() => refreshed!);
    expect(first._tag).toBe("Failure");
    if (first._tag === "Failure")
      expect(first.failure).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed);
    const retried = yield* index.searchText(input);
    expect(retried.nextCursor).toBeDefined();
    const next = yield* index.searchText({ ...input, cursor: retried.nextCursor! });
    expect(next.matches.map((match) => match.lineNumber)).toEqual([2]);
    expect(next.nextCursor).toBeUndefined();
  }),
);

it.effect("invalidates pages created while a native refresh is still running", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(root, "file.txt"), "needle\nneedle"),
    );
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readinessCalls = 0;
    vi.spyOn(FileFinder, "create").mockReturnValue({
      ok: true,
      value: mockFinder({
        scanFiles: () => ({ ok: true, value: undefined }),
        waitForIndexReady: async () => {
          if (++readinessCalls > 1) {
            begin();
            await finish;
          }
          return { ok: true, value: true };
        },
        grep: () => ({
          ok: true,
          value: grepResult([
            grepMatch({ relativePath: "file.txt", lineNumber: 1 }),
            grepMatch({ relativePath: "file.txt", lineNumber: 2 }),
          ]),
        }),
      } as Partial<FileFinder>),
    });
    const index = yield* WorkspaceSearchIndex.make(realRoot, "content");
    const input = {
      query: "needle",
      limit: 1,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    };
    try {
      const refreshing = yield* index.refresh().pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      const page = yield* index.searchText(input);
      expect(page.nextCursor).toBeDefined();
      release();
      yield* Fiber.join(refreshing);
      const continuation = yield* index
        .searchText({ ...input, cursor: page.nextCursor! })
        .pipe(Effect.result);
      expect(continuation._tag).toBe("Failure");
    } finally {
      release();
    }
  }),
);
