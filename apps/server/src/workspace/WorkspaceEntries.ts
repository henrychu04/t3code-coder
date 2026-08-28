// @effect-diagnostics nodeBuiltinImport:off -- Directory browsing is a small Linux filesystem adapter.
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";

import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectTextSearchInput,
  ProjectTextSearchResult,
  WorkspaceListDirectoriesInput,
  WorkspaceListDirectoriesResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const MAX_LISTED_DIRECTORIES = 500;
type WorkspaceListEntriesInput = Pick<ProjectListEntriesInput, "cwd">;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly list: (
      input: WorkspaceListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
    readonly searchText: (
      input: Omit<ProjectTextSearchInput, "threadId">,
    ) => Effect.Effect<ProjectTextSearchResult, WorkspaceEntriesError>;
    readonly listDirectories: (
      input: WorkspaceListDirectoriesInput,
    ) => Effect.Effect<WorkspaceListDirectoriesResult, WorkspaceDirectoryListFailed>;
  }
>()("t3/workspace/WorkspaceEntries") {}

export class WorkspaceDirectoryListFailed extends Schema.TaggedErrorClass<WorkspaceDirectoryListFailed>()(
  "WorkspaceDirectoryListFailed",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list directories in '${this.path}'.`;
  }
}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const searchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeRealWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeRealWorkspaceRoot")(
    function* (cwd: string) {
      const normalized = yield* workspacePaths.normalizeWorkspaceRoot(cwd);
      return yield* Effect.tryPromise({
        try: () => NodeFS.realpath(normalized),
        catch: () =>
          new WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed({
            reason: "Failed to resolve the verified project root.",
          }),
      });
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const cwd = yield* normalizeRealWorkspaceRoot(input.cwd);
      const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/u });
      return yield* Effect.gen(function* () {
        const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* index.search(query, input.limit, input.kind, input.imageOnly, input.fileMask);
      }).pipe(
        Effect.provide(
          searchIndexes.get(WorkspaceSearchIndex.workspaceSearchIndexKey(cwd, "paths")),
        ),
      );
    },
  );

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const cwd = yield* normalizeRealWorkspaceRoot(input.cwd);
      return yield* Effect.gen(function* () {
        const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* index.list();
      }).pipe(
        Effect.provide(
          searchIndexes.get(WorkspaceSearchIndex.workspaceSearchIndexKey(cwd, "paths")),
        ),
      );
    },
  );

  const searchText: WorkspaceEntries["Service"]["searchText"] = Effect.fn(
    "WorkspaceEntries.searchText",
  )(function* (input) {
    const cwd = yield* normalizeRealWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* index.searchText(input);
    }).pipe(
      Effect.provide(
        searchIndexes.get(WorkspaceSearchIndex.workspaceSearchIndexKey(cwd, "content")),
      ),
    );
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeRealWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const key = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(searchIndexes.rcMap, key))) continue;
        yield* Effect.gen(function* () {
          const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* index.refresh();
        }).pipe(
          Effect.provide(searchIndexes.get(key)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: () => searchIndexes.invalidate(key),
            WorkspaceSearchIndexScanTimedOut: () => searchIndexes.invalidate(key),
            WorkspaceSearchIndexRefreshFailed: () => searchIndexes.invalidate(key),
          }),
        );
      }
    },
  );

  const listDirectories: WorkspaceEntries["Service"]["listDirectories"] = Effect.fn(
    "WorkspaceEntries.listDirectories",
  )(function* (input) {
    const requestedPath = input.path?.trim() ?? NodeOS.homedir();
    if (!path.isAbsolute(requestedPath)) {
      return yield* new WorkspaceDirectoryListFailed({
        path: requestedPath,
        cause: new Error("Workspace directory paths must be absolute."),
      });
    }
    const directory = path.resolve(requestedPath);
    const directories = yield* Effect.tryPromise({
      try: async () => {
        const entries = await NodeFS.readdir(directory, { withFileTypes: true });
        const candidates = await Promise.all(
          entries.map(async (entry) => {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) return { name: entry.name, path: entryPath };
            if (!entry.isSymbolicLink()) return null;
            try {
              return (await NodeFS.stat(entryPath)).isDirectory()
                ? { name: entry.name, path: entryPath }
                : null;
            } catch {
              return null;
            }
          }),
        );
        return candidates
          .filter(
            (entry): entry is { readonly name: string; readonly path: string } => entry !== null,
          )
          .sort((left, right) => left.name.localeCompare(right.name));
      },
      catch: (cause) => new WorkspaceDirectoryListFailed({ path: directory, cause }),
    });
    const parentPath = path.dirname(directory);
    return {
      path: directory,
      ...(parentPath === directory ? {} : { parentPath }),
      directories: directories.slice(0, MAX_LISTED_DIRECTORIES),
      truncated: directories.length > MAX_LISTED_DIRECTORIES,
    };
  });

  return WorkspaceEntries.of({ search, searchText, list, listDirectories, refresh });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
