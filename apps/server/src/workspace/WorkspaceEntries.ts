// @effect-diagnostics nodeBuiltinImport:off -- Workspace enumeration is a small Linux process/filesystem adapter.
import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import { promisify } from "node:util";

import type {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "./WorkspacePaths.ts";

const execFileAsync = promisify(execFile);
const MAX_SCANNED_PATHS = 25_000;

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

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

const normalizePath = (value: string): string => value.replaceAll("\\", "/").replace(/^\.\//, "");

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const readPaths = (cwd: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard"],
            { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          );
          return stdout.split("\n").filter(Boolean).slice(0, MAX_SCANNED_PATHS);
        } catch {
          const entries = await NodeFS.readdir(cwd, { recursive: true, withFileTypes: true });
          return entries
            .filter((entry) => entry.isFile())
            .map((entry) =>
              normalizePath(path.relative(cwd, path.join(entry.parentPath, entry.name))),
            )
            .slice(0, MAX_SCANNED_PATHS);
        }
      },
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: 0,
          pageSize: MAX_SCANNED_PATHS,
          reason: "Failed to enumerate workspace paths.",
          cause,
        }),
    });

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const cwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const query = input.query
        .trim()
        .replace(/^[@./]+/, "")
        .toLocaleLowerCase();
      const paths = yield* readPaths(cwd).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceSearchIndexSearchFailed({
              ...error,
              queryLength: query.length,
              pageSize: input.limit,
            }),
        ),
      );
      const directories = new Set<string>();
      for (const file of paths) {
        let directory = normalizePath(file).split("/").slice(0, -1).join("/");
        while (directory.length > 0) {
          directories.add(directory);
          directory = directory.split("/").slice(0, -1).join("/");
        }
      }
      const candidates: ProjectEntry[] = [
        ...paths.map((entry) => ({ path: normalizePath(entry), kind: "file" as const })),
        ...[...directories].map((entry) => ({ path: entry, kind: "directory" as const })),
      ];
      const matching = candidates.filter(
        (entry) =>
          (input.kind === undefined || entry.kind === input.kind) &&
          (!input.imageOnly || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(entry.path)) &&
          (query.length === 0 || entry.path.toLocaleLowerCase().includes(query)),
      );
      return { entries: matching.slice(0, input.limit), truncated: matching.length > input.limit };
    },
  );

  return WorkspaceEntries.of({ search, refresh: () => Effect.void });
});

export const layer = Layer.effect(WorkspaceEntries, make);
