// Coder: the Files surface boundary (see "Files surface" in docs/internals/coder-only.md) replaces
// upstream's reads of absolute host paths and create-anywhere writes: reads and edits accept only
// project-relative paths inside the real project root, edits apply to existing text files under a
// per-file lock with the read revision checked for staleness, and files are replaced atomically.
// `createFile` writes a new text file only, for upstream's "Save to workspace" of a proposed plan.
// `getMetadata` is upstream's: it stats absolute workspace paths for file chip icons and reads at
// most 512 header bytes of an extensionless file, returning no contents.
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_FILE_MAX_BYTES,
  type FilesystemEntryMetadata,
  type FilesystemGetMetadataInput,
  type FilesystemGetMetadataResult,
  type ProjectCreateFileInput,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

// Windows also reaches `.git` through trailing dots or spaces, a `:` stream
// suffix, or the 8.3 short name `GIT~1`. Names compare upcased, as NTFS does.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

type WorkspaceReadFileInput = Omit<ProjectReadFileInput, "threadId">;
type WorkspaceWriteFileInput = Omit<ProjectWriteFileInput, "threadId">;
type WorkspaceCreateFileInput = Omit<ProjectCreateFileInput, "threadId" | "draftProjectId">;

function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
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

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {}

export class WorkspaceFileStaleError extends Schema.TaggedError<WorkspaceFileStaleError>()(
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
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: WorkspaceReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: WorkspaceWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /** Writes inside a known workspace only. */
    readonly createFile: (
      input: WorkspaceCreateFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const writeLocks = yield* RcMap.make({ lookup: (_path: string) => Semaphore.make(1) });
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refreshWorker = yield* makeKeyedCoalescingWorker<string, boolean, never, never>({
    merge: () => true,
    process: (cwd) => workspaceEntries.refresh(cwd),
  });

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  /**
   * Git runs config and hooks from its own folders, so a write never lands in one:
   * a `.git` entry, or a repository folder under another name such as `.bare`.
   * Folders are checked upward to a linked worktree's top, which holds a `.git`
   * file, since worktrees can sit inside a bare repository. `absolutePath` must
   * be normalized.
   */
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // What git reads as a repository: HEAD, plus objects and refs here or in
      // the folder a `commondir` file names, as in a linked worktree's git folder.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  // Coder: an edit or new file also refuses git folders and unknown workspaces, as upstream's
  // resolveWriteTarget does; the fork's writes keep their own existing-file and create-only paths.
  const refuseGitFolder = Effect.fn("WorkspaceFileSystem.refuseGitFolder")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly realWorkspaceRoot: string;
    readonly namedTargetPath: string;
    readonly realTargetPath: string;
  }) {
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const inGitFolder = (checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      });
    if ((yield* inGitFolder(input.realTargetPath)) || (yield* inGitFolder(input.namedTargetPath))) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: input.realWorkspaceRoot,
        resolvedPath: input.realTargetPath,
      });
    }
  });

  const resolveExisting = Effect.fn("WorkspaceFileSystem.resolveExisting")(function* (input: {
    cwd: string;
    relativePath: string;
    allowMissing?: boolean | undefined;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
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
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
      },
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
    const realTargetPath = resolved.realTargetPath;
    if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { target, realWorkspaceRoot, realTargetPath, exists: resolved.exists };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const { target, realTargetPath, exists } = yield* resolveExisting(input);
    if (!exists) {
      // Upstream's `allowMissing` read of an optional file (t3.json) that is absent.
      return {
        relativePath: target.relativePath,
        contents: "",
        byteLength: 0,
        truncated: false,
        revision: revisionOf(new Uint8Array()),
        exists: false,
      };
    }
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
    yield* knownWorkspaces.assertContains(input.cwd);
    const { target, realWorkspaceRoot, realTargetPath } = yield* resolveExisting(input);
    yield* refuseGitFolder({
      cwd: input.cwd,
      relativePath: input.relativePath,
      realWorkspaceRoot,
      namedTargetPath: path.resolve(target.absolutePath),
      realTargetPath,
    });
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
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* RcMap.get(writeLocks, realTargetPath);
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
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
            // Node filesystem promises cannot be cancelled. Keep ownership of the lock
            // until the physical write finishes, even if the RPC caller disconnects.
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
            }).pipe(
              Effect.tap(() => refreshWorker.enqueue(input.cwd, true)),
              Effect.uninterruptible,
            );
            return { relativePath: target.relativePath, revision: revisionOf(bytes) };
          }),
        );
      }),
    );
  });

  /** Creates a new text file; an existing path, even a symlink, is never replaced or followed. */
  const createFile: WorkspaceFileSystem["Service"]["createFile"] = Effect.fn(
    "WorkspaceFileSystem.createFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const bytes = new TextEncoder().encode(input.contents);
    const failure = (
      operation: "realpath-workspace-root" | "make-directory" | "write-file",
      cause: unknown,
    ) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        operationPath: target.absolutePath,
        operation,
        cause,
      });
    if (bytes.byteLength > PROJECT_FILE_MAX_BYTES) {
      return yield* failure(
        "write-file",
        new Error(`Workspace text files are limited to ${PROJECT_FILE_MAX_BYTES} bytes.`),
      );
    }
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) => failure("realpath-workspace-root", cause),
    });
    // No folder is made inside a git folder: the path as named is checked before creation.
    const namedTargetPath = path.resolve(target.absolutePath);
    yield* refuseGitFolder({
      cwd: input.cwd,
      relativePath: input.relativePath,
      realWorkspaceRoot,
      namedTargetPath,
      realTargetPath: namedTargetPath,
    });
    // A symlinked ancestor must not carry the new file, or the folders made for it, outside the
    // project: the nearest existing ancestor is checked before any folder is made, and the parent
    // is resolved again afterwards.
    const realParent = yield* Effect.tryPromise({
      try: async () => {
        const parent = NodePath.dirname(target.absolutePath);
        let existing = parent;
        while (
          !(await NodeFSP.stat(existing).then(
            () => true,
            () => false,
          ))
        ) {
          existing = NodePath.dirname(existing);
        }
        if (!isInsideRealRoot(realWorkspaceRoot, await NodeFSP.realpath(existing))) return null;
        await NodeFSP.mkdir(parent, { recursive: true });
        return NodeFSP.realpath(parent);
      },
      catch: (cause) => failure("make-directory", cause),
    });
    if (realParent === null) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: target.absolutePath,
      });
    }
    const realTargetPath = NodePath.join(realParent, NodePath.basename(target.absolutePath));
    if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    yield* refuseGitFolder({
      cwd: input.cwd,
      relativePath: input.relativePath,
      realWorkspaceRoot,
      namedTargetPath,
      realTargetPath,
    });
    yield* Effect.tryPromise({
      try: () => NodeFSP.writeFile(realTargetPath, bytes, { flag: "wx" }),
      catch: (cause) => failure("write-file", cause),
    }).pipe(
      Effect.tap(() => refreshWorker.enqueue(input.cwd, true)),
      Effect.uninterruptible,
    );
    return { relativePath: target.relativePath, revision: revisionOf(bytes) };
  });

  return WorkspaceFileSystem.of({ getMetadata, readFile, writeFile, createFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
