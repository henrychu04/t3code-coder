import {
  type DirItem,
  type DirSearchResult,
  type FileItem,
  FileFinder,
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
} from "@t3tools/contracts";
import { matchesFileMask } from "@t3tools/shared/fileMask";
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

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedErrorClass<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
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

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinder,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
) {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) => onFailure({ reason: "FileFinder.waitForIndexReady rejected.", cause }),
  });
  if (!result.ok) return yield* Effect.fail(onFailure({ reason: result.error }));
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (cwd: string) {
  const finder = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        FileFinder.create({
          basePath: cwd,
          disableMmapCache: true,
          disableContentIndexing: true,
          aiMode: false,
        }),
      catch: (cause) =>
        new WorkspaceSearchIndexCreateFailed({
          cwd,
          reason: "FileFinder.create threw unexpectedly.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.value)
          : Effect.fail(new WorkspaceSearchIndexCreateFailed({ cwd, reason: result.error })),
      ),
    ),
    (instance) =>
      Effect.try({
        try: () => instance.destroy(),
        catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
      }).pipe(Effect.orDie),
  );
  yield* waitForIndexReady(
    cwd,
    finder,
    ({ reason, cause }) => new WorkspaceSearchIndexCreateFailed({ cwd, reason, cause }),
  );

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "mixedSearch",
    execute: () => Result<A>,
  ) {
    const result = yield* Effect.try({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFiles threw unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({ cwd, reason: result.error });
    }
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) => new WorkspaceSearchIndexRefreshFailed({ cwd, reason, cause }),
    );
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
      const filtered = imageOnly || fileMask.trim().length > 0;
      const pageSize = filtered ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(query, { pageSize }),
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

  return WorkspaceSearchIndex.of({ list, refresh, search });
});

export const layer = (cwd: string) => Layer.effect(WorkspaceSearchIndex, make(cwd));

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
