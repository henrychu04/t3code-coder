// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectTextSearchInput,
  ProjectTextSearchResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_FILE_MAX_BYTES = 1024 * 1024;
const PROJECT_TEXT_SEARCH_MAX_FILES = 2_000;
const PROJECT_TEXT_SEARCH_MAX_BYTES = 32 * 1024 * 1024;
type WorkspaceReadFileInput = Omit<ProjectReadFileInput, "threadId">;
type WorkspaceTextSearchInput = Omit<ProjectTextSearchInput, "threadId">;
type WorkspaceWriteFileInput = Omit<ProjectWriteFileInput, "threadId">;

function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "rename-file",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceFileStaleError extends Schema.TaggedErrorClass<WorkspaceFileStaleError>()(
  "WorkspaceFileStaleError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileStaleError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly readFile: (
      input: WorkspaceReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly writeFile: (
      input: WorkspaceWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly searchText: (
      input: WorkspaceTextSearchInput,
    ) => Effect.Effect<
      ProjectTextSearchResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | WorkspaceEntries.WorkspaceEntriesError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

function isContained(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const resolveExisting = Effect.fn("WorkspaceFileSystem.resolveExisting")(function* (input: {
    cwd: string;
    relativePath: string;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isContained(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { target, realTargetPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const { target, realTargetPath } = yield* resolveExisting(input);
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(realTargetPath, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) return { kind: "not-file" as const };
          const byteCount = Math.min(stat.size, PROJECT_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(byteCount);
          const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
          return { kind: "file" as const, bytes: buffer.subarray(0, bytesRead), stat };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "read",
          cause,
        }),
    });
    if (read.kind === "not-file") {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }
    if (read.bytes.includes(0)) {
      return yield* new WorkspaceBinaryFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return yield* new WorkspaceBinaryFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      contents,
      byteLength: read.stat.size,
      truncated: read.stat.size > PROJECT_FILE_MAX_BYTES,
      revision: revisionOf(read.bytes),
    };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const { target, realTargetPath } = yield* resolveExisting(input);
    const bytes = new TextEncoder().encode(input.contents);
    if (bytes.byteLength > PROJECT_FILE_MAX_BYTES) {
      return yield* new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
        operationPath: realTargetPath,
        operation: "write-file",
        cause: new Error(`Workspace text files are limited to ${PROJECT_FILE_MAX_BYTES} bytes.`),
      });
    }
    const current = yield* readFile({ cwd: input.cwd, relativePath: input.relativePath });
    if (current.truncated || current.revision !== input.expectedRevision) {
      return yield* new WorkspaceFileStaleError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }
    const temporaryPath = NodePath.join(
      NodePath.dirname(realTargetPath),
      `.${NodePath.basename(realTargetPath)}.t3-${randomUUID()}.tmp`,
    );
    yield* Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.stat(realTargetPath);
        try {
          await NodeFSP.writeFile(temporaryPath, bytes, { mode: stat.mode });
          await NodeFSP.rename(temporaryPath, realTargetPath);
        } catch (error) {
          await NodeFSP.rm(temporaryPath, { force: true });
          throw error;
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "write-file",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, revision: revisionOf(bytes) };
  });

  const searchText: WorkspaceFileSystem["Service"]["searchText"] = Effect.fn(
    "WorkspaceFileSystem.searchText",
  )(function* (input) {
    const fileMask = input.fileMask?.trim() ?? "";
    const listed = fileMask
      ? yield* workspaceEntries.search({
          cwd: input.cwd,
          query: "",
          limit: PROJECT_TEXT_SEARCH_MAX_FILES + 1,
          kind: "file",
          fileMask,
        })
      : yield* workspaceEntries.list({ cwd: input.cwd });
    const fileEntries = listed.entries.filter((entry) => entry.kind === "file");
    const candidates = fileEntries.slice(0, PROJECT_TEXT_SEARCH_MAX_FILES);
    const needle = input.query.toLocaleLowerCase();
    const matches: Array<ProjectTextSearchResult["matches"][number]> = [];
    let scannedBytes = 0;
    let truncated = listed.truncated || fileEntries.length > candidates.length;

    for (const entry of candidates) {
      if (matches.length >= input.limit || scannedBytes >= PROJECT_TEXT_SEARCH_MAX_BYTES) {
        truncated = true;
        break;
      }
      const file = yield* readFile({ cwd: input.cwd, relativePath: entry.path }).pipe(
        Effect.option,
      );
      if (file._tag === "None") continue;
      const fileBytes = Math.min(file.value.byteLength, PROJECT_FILE_MAX_BYTES);
      if (scannedBytes + fileBytes > PROJECT_TEXT_SEARCH_MAX_BYTES) {
        truncated = true;
        break;
      }
      scannedBytes += fileBytes;
      const lines = file.value.contents.split(/\r\n|\r|\n/);
      for (const [lineIndex, line] of lines.entries()) {
        let from = 0;
        const normalizedLine = line.toLocaleLowerCase();
        while (from <= normalizedLine.length) {
          const columnIndex = normalizedLine.indexOf(needle, from);
          if (columnIndex < 0) break;
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: columnIndex + 1,
            preview: line.trim().slice(0, 512),
          });
          if (matches.length >= input.limit) {
            truncated = true;
            break;
          }
          from = columnIndex + Math.max(1, needle.length);
        }
        if (matches.length >= input.limit) break;
      }
    }

    return { matches, truncated };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile, searchText });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
