// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type DirItem,
  type DirSearchResult,
  type FileItem,
  FileFinder,
  type GrepCursor,
  type GrepMatch,
  type MixedItem,
  type MixedSearchResult,
  type Result,
  type SearchResult,
} from "@ff-labs/fff-node";
import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchEntriesResult,
  ProjectTextSearchInput,
  ProjectTextSearchResult,
} from "@t3tools/contracts";
import { matchesFileMask, parseFileMask } from "@t3tools/shared/fileMask";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
const CONTENT_SEARCH_MAX_TOTAL_MATCHES = 500;
const CONTENT_SEARCH_MAX_LINE_CHARS = 4096;
const CONTENT_SEARCH_MAX_PATH_CHARS = 512;

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    reason: Schema.String,
  },
) {}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedErrorClass<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    timeout: Schema.String,
  },
) {}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
  },
) {}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    reason: Schema.String,
  },
) {}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    reason: Schema.String,
  },
) {}

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
      fileMask?: string,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly searchText: (
      input: Omit<ProjectTextSearchInput, "cwd" | "threadId">,
    ) => Effect.Effect<ProjectTextSearchResult, WorkspaceSearchIndexSearchFailed>;
    readonly refresh: () => Effect.Effect<
      void,
      WorkspaceSearchIndexRefreshFailed | WorkspaceSearchIndexScanTimedOut
    >;
  }
>()("t3/workspace/WorkspaceSearchIndex") {}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/\/$/u, "");
}

function toProjectEntry(item: MixedItem): ProjectEntry | null {
  const path = normalizePath(item.item.relativePath);
  return path ? { path, kind: item.type } : null;
}

function toFileEntry(item: FileItem): ProjectEntry | null {
  const path = normalizePath(item.relativePath);
  return path ? { path, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem): ProjectEntry | null {
  const path = normalizePath(item.relativePath);
  return path ? { path, kind: "directory" } : null;
}

function mapFileSearchResult(
  result: SearchResult,
  limit: number,
  imageOnly: boolean,
  fileMask: string,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item);
    return entry &&
      (!imageOnly || isWorkspaceImagePreviewPath(entry.path)) &&
      matchesFileMask(entry.path, fileMask)
      ? [entry]
      : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: DirSearchResult,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item);
    return entry ? [entry] : [];
  });
  const rootCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched - rootCount > entries.length,
  };
}

function mapMixedSearchResult(
  result: MixedSearchResult,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toProjectEntry(item);
    return entry ? [entry] : [];
  });
  const rootCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched - rootCount > entries.length,
  };
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previousCodeUnit = line.charCodeAt(index - 1);
  const previousIndex =
    previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(line, previousIndex);
}

function buildContentSearchQuery(input: Omit<ProjectTextSearchInput, "cwd" | "threadId">): {
  readonly searchQuery: string;
  readonly regexMode: boolean;
} {
  const query = input.caseSensitive
    ? input.query
    : input.useRegex
      ? `(?i)${input.query}`
      : input.query.toLowerCase();
  const nativeMask = input.fileMask?.trim() ? toFffFileMaskConstraint(input.fileMask) : "";
  return {
    searchQuery: [nativeMask ?? "", query].filter(Boolean).join(" "),
    regexMode: input.useRegex,
  };
}

function byteRangesToStringRanges(
  line: string,
  byteRanges: ReadonlyArray<readonly [number, number]>,
): Array<{ readonly start: number; readonly end: number }> {
  const bytes = Buffer.from(line);
  const toStringIndex = (byteOffset: number) =>
    bytes.subarray(0, Math.min(bytes.length, Math.max(0, byteOffset))).toString().length;
  return byteRanges.map(([startByte, endByte]) => ({
    start: toStringIndex(startByte),
    end: toStringIndex(endByte),
  }));
}

function isWholeWordRange(
  line: string,
  range: { readonly start: number; readonly end: number },
): boolean {
  if (range.end <= range.start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start));
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end));
  return leftIsBoundary && rightIsBoundary;
}

function boundedMatchLine(
  line: string,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): { readonly lineContent: string; readonly matchRanges: Array<{ start: number; end: number }> } {
  if (line.length <= CONTENT_SEARCH_MAX_LINE_CHARS) {
    return { lineContent: line, matchRanges: [...ranges] };
  }
  const firstStart = ranges[0]?.start ?? 0;
  const start = Math.max(0, firstStart - Math.floor(CONTENT_SEARCH_MAX_LINE_CHARS / 3));
  const end = Math.min(line.length, start + CONTENT_SEARCH_MAX_LINE_CHARS);
  return {
    lineContent: line.slice(start, end),
    matchRanges: ranges.flatMap((range) => {
      const clippedStart = Math.max(start, range.start);
      const clippedEnd = Math.min(end, range.end);
      return clippedEnd > clippedStart
        ? [{ start: clippedStart - start, end: clippedEnd - start }]
        : [];
    }),
  };
}

function safeRelativeSearchPath(input: string): string | null {
  if (!input || input.length > CONTENT_SEARCH_MAX_PATH_CHARS || input.includes("\0")) return null;
  const path = normalizePath(input);
  if (NodePath.posix.isAbsolute(path)) return null;
  const normalized = NodePath.posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== path
  ) {
    return null;
  }
  return normalized;
}

async function validateContentMatchPath(
  realProjectRoot: string,
  match: GrepMatch,
): Promise<string | null> {
  if (match.isBinary || match.lineContent.includes("\0") || match.lineContent.includes("�")) {
    return null;
  }
  const relativePath = safeRelativeSearchPath(match.relativePath);
  if (!relativePath) return null;
  const absolutePath = NodePath.resolve(realProjectRoot, relativePath);
  if (!isContained(realProjectRoot, absolutePath)) return null;
  try {
    const [realPath, stat] = await Promise.all([
      NodeFSP.realpath(absolutePath),
      NodeFSP.stat(absolutePath),
    ]);
    return stat.isFile() && isContained(realProjectRoot, realPath) ? relativePath : null;
  } catch {
    return null;
  }
}

function isContained(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let separator = entry.path.lastIndexOf("/");
    while (separator > 0) {
      const parent = entry.path.slice(0, separator);
      if (!byPath.has(parent)) byPath.set(parent, { path: parent, kind: "directory" });
      separator = parent.lastIndexOf("/");
    }
  }
  return [...byPath.values()];
}

const FFF_UNSAFE_FILE_MASK_CHARACTER = /[\s\\/[\]{}:]/u;

/**
 * Compile IntelliJ filename masks into FFF path constraints. FFF constraints
 * operate on project-relative paths, so every filename pattern is anchored to
 * the final path segment. Unsupported literals fall back to the broad native
 * file search plus the exact IntelliJ matcher.
 */
function toFffFileMaskConstraint(fileMask: string): string | undefined {
  const { includes, excludes } = parseFileMask(fileMask);
  const patterns = [...includes, ...excludes];
  if (patterns.some((pattern) => FFF_UNSAFE_FILE_MASK_CHARACTER.test(pattern))) {
    return undefined;
  }

  const includeConstraint =
    includes.length === 0
      ? ""
      : includes.length === 1
        ? `**/${includes[0]}`
        : `{${includes.map((pattern) => `**/${pattern}`).join(",")}}`;
  const excludeConstraints = excludes.map((pattern) => `!**/${pattern}`);
  return [includeConstraint, ...excludeConstraints].filter(Boolean).join(" ");
}

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  finder: FileFinder,
  onFailure: (reason: string) => E,
) {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: () => onFailure("FileFinder.waitForIndexReady rejected."),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure("FileFinder.waitForIndexReady returned an error."));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"] as const;
export type WorkspaceSearchIndexVariant = (typeof WORKSPACE_SEARCH_INDEX_VARIANTS)[number];

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
) {
  const finder = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        FileFinder.create({
          basePath: cwd,
          disableMmapCache: true,
          disableContentIndexing: variant !== "content",
          aiMode: false,
          enableFsRootScanning: false,
          enableHomeDirScanning: false,
        }),
      catch: () =>
        new WorkspaceSearchIndexCreateFailed({
          reason: "FileFinder.create threw unexpectedly.",
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.value)
          : Effect.fail(
              new WorkspaceSearchIndexCreateFailed({
                reason: "FileFinder.create returned an error.",
              }),
            ),
      ),
    ),
    (instance) =>
      Effect.try({
        try: () => instance.destroy(),
        catch: () =>
          new WorkspaceSearchIndexDestroyFailed({
            reason: "FileFinder.destroy threw unexpectedly.",
          }),
      }).pipe(Effect.orDie),
  );
  yield* waitForIndexReady(finder, (reason) => new WorkspaceSearchIndexCreateFailed({ reason }));

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Result<A>,
  ) {
    const result = yield* Effect.try({
      try: execute,
      catch: () =>
        new WorkspaceSearchIndexSearchFailed({
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        queryLength: query.length,
        pageSize,
        reason: `FileFinder.${operation} returned an error.`,
      });
    }
    return result.value;
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: () =>
        new WorkspaceSearchIndexRefreshFailed({
          reason: "FileFinder.scanFiles threw unexpectedly.",
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        reason: "FileFinder.scanFiles returned an error.",
      });
    }
    yield* waitForIndexReady(finder, (reason) => new WorkspaceSearchIndexRefreshFailed({ reason }));
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const result = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "mixedSearch", () =>
        finder.mixedSearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const sorted = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      return {
        entries: sorted.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: mapped.truncated || sorted.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
  );

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit, kind, imageOnly = false, fileMask = "") {
    if (kind === "file" || imageOnly || fileMask.trim().length > 0) {
      const hasFileMask = fileMask.trim().length > 0;
      const nativeFileMask = hasFileMask ? toFffFileMaskConstraint(fileMask) : "";
      const nativeQuery =
        nativeFileMask === undefined ? query : [nativeFileMask, query].filter(Boolean).join(" ");
      const filtered = imageOnly || hasFileMask;
      const pageSize = filtered ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(nativeQuery, { pageSize }),
      );
      return mapFileSearchResult(result, limit, imageOnly, fileMask);
    }
    if (kind === "directory") {
      const pageSize = Math.max(1, limit + 1);
      const result = yield* runSearch(query, pageSize, "directorySearch", () =>
        finder.directorySearch(query, { pageSize }),
      );
      return mapDirectorySearchResult(result, limit);
    }
    const pageSize = Math.max(1, limit + 1);
    const result = yield* runSearch(query, pageSize, "mixedSearch", () =>
      finder.mixedSearch(query, { pageSize }),
    );
    return mapMixedSearchResult(result, limit);
  });

  const searchText: WorkspaceSearchIndex["Service"]["searchText"] = Effect.fn(
    "WorkspaceSearchIndex.searchText",
  )(function* (input) {
    const limit = Math.min(input.limit, CONTENT_SEARCH_MAX_TOTAL_MATCHES);
    const { searchQuery, regexMode } = buildContentSearchQuery(input);
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    const rawPageSize = Math.min(
      CONTENT_SEARCH_MAX_TOTAL_MATCHES,
      input.wholeWord ? Math.max(limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE) : limit,
    );
    const nativeMaskSupported =
      !input.fileMask?.trim() || toFffFileMaskConstraint(input.fileMask) !== undefined;
    const matches: Array<ProjectTextSearchResult["matches"][number]> = [];
    const matchesPerFile = new Map<string, number>();
    let nextCursor: GrepCursor | null = null;
    let invalidRegex = false;
    let truncated = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const result = yield* runSearch(input.query, rawPageSize, "grep", () =>
        finder.grep(searchQuery, {
          mode: regexMode ? "regex" : "plain",
          smartCase: !input.caseSensitive && !regexMode,
          maxFileSize: 10 * 1024 * 1024,
          maxMatchesPerFile: CONTENT_SEARCH_MAX_MATCHES_PER_FILE,
          pageSize: rawPageSize,
          cursor: nextCursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      if (result.regexFallbackError !== undefined) {
        invalidRegex = true;
        nextCursor = null;
        break;
      }

      for (const match of result.items) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        if (
          !nativeMaskSupported &&
          input.fileMask &&
          !matchesFileMask(match.relativePath, input.fileMask)
        ) {
          continue;
        }
        const relativePath = yield* Effect.promise(() => validateContentMatchPath(cwd, match));
        if (!relativePath || !Number.isSafeInteger(match.lineNumber) || match.lineNumber < 1) {
          continue;
        }
        const ranges = byteRangesToStringRanges(match.lineContent, match.matchRanges)
          .filter(
            (range) =>
              range.start >= 0 && range.end <= match.lineContent.length && range.end > range.start,
          )
          .filter((range) => !input.wholeWord || isWholeWordRange(match.lineContent, range))
          .slice(0, 100);
        if (ranges.length === 0) continue;
        const bounded = boundedMatchLine(match.lineContent, ranges);
        if (bounded.matchRanges.length === 0) continue;
        const fileMatchCount = matchesPerFile.get(relativePath) ?? 0;
        if (fileMatchCount >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) {
          truncated = true;
          continue;
        }
        matches.push({
          path: relativePath,
          lineNumber: match.lineNumber,
          lineContent: bounded.lineContent,
          matchRanges: bounded.matchRanges,
        });
        matchesPerFile.set(relativePath, fileMatchCount + 1);
      }
      nextCursor = result.nextCursor;
    } while (matches.length < limit && nextCursor !== null && performance.now() < deadline);

    return {
      matches,
      truncated: truncated || nextCursor !== null,
      ...(invalidRegex ? { regexFallbackError: "Invalid regular expression." } : {}),
    };
  });

  return WorkspaceSearchIndex.of({ list, refresh, search, searchText });
});

export const workspaceSearchIndexKey = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
  `${variant}\n${cwd}`;

function parseWorkspaceSearchIndexKey(key: string): {
  readonly cwd: string;
  readonly variant: WorkspaceSearchIndexVariant;
} {
  const separatorIndex = key.indexOf("\n");
  return {
    variant: key.slice(0, separatorIndex) as WorkspaceSearchIndexVariant,
    cwd: key.slice(separatorIndex + 1),
  };
}

export const layer = (key: string) => {
  const { cwd, variant } = parseWorkspaceSearchIndexKey(key);
  return Layer.effect(WorkspaceSearchIndex, make(cwd, variant));
};

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
