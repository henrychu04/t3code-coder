import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_TEXT_SEARCH_MAX_LIMIT = 500;
export const PROJECT_SEARCH_INPUT_MAX_LENGTH = 256;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_CONTENT_MAX_LENGTH = 1024 * 1024;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // An empty query is a bounded browse: the index returns frecency-ordered
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(PROJECT_SEARCH_INPUT_MAX_LENGTH)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
  fileMask: Schema.optional(
    TrimmedString.check(Schema.isMaxLength(PROJECT_SEARCH_INPUT_MAX_LENGTH)),
  ),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectTextSearchInput = Schema.Struct({
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  // Leading and trailing whitespace are meaningful in content queries.
  query: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(PROJECT_SEARCH_INPUT_MAX_LENGTH),
  ),
  fileMask: Schema.optional(
    TrimmedString.check(Schema.isMaxLength(PROJECT_SEARCH_INPUT_MAX_LENGTH)),
  ),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_TEXT_SEARCH_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectTextSearchInput = typeof ProjectTextSearchInput.Type;

export const ProjectTextSearchMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectTextSearchMatchRange = typeof ProjectTextSearchMatchRange.Type;

export const ProjectTextSearchMatch = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  lineNumber: PositiveInt,
  lineContent: Schema.String.check(Schema.isMaxLength(4096)),
  matchRanges: Schema.Array(ProjectTextSearchMatchRange).check(Schema.isMaxLength(100)),
});
export type ProjectTextSearchMatch = typeof ProjectTextSearchMatch.Type;

export const ProjectTextSearchResult = Schema.Struct({
  nextCursor: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  matches: Schema.Array(ProjectTextSearchMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type ProjectTextSearchResult = typeof ProjectTextSearchResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const WorkspaceListDirectoriesInput = Schema.Struct({
  path: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceListDirectoriesInput = typeof WorkspaceListDirectoriesInput.Type;

export const WorkspaceDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type WorkspaceDirectoryEntry = typeof WorkspaceDirectoryEntry.Type;

export const WorkspaceListDirectoriesResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  directories: Schema.Array(WorkspaceDirectoryEntry),
  truncated: Schema.Boolean,
});
export type WorkspaceListDirectoriesResult = typeof WorkspaceListDirectoriesResult.Type;

export class WorkspaceListDirectoriesError extends Schema.TaggedErrorClass<WorkspaceListDirectoriesError>()(
  "WorkspaceListDirectoriesError",
  {
    path: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
  "workspace_not_owned_by_thread",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured fields remain optional on the wire so older message-only errors decode.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectTextSearchError extends Schema.TaggedErrorClass<ProjectTextSearchError>()(
  "ProjectTextSearchError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured fields remain optional so older message-only errors can decode.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly queryLength: number;
    readonly limit: number;
    readonly failure: ProjectEntriesFailure;
    readonly detail?: string;
  }) {
    super({
      ...props,
      message: "Failed to search project contents.",
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  revision: TrimmedNonEmptyString,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "stale_file",
  "workspace_not_owned_by_thread",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
  "rename-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

function projectFileFailureMessage(
  action: "read" | "write",
  props: ProjectFileFailureContext,
): string {
  const path = props.relativePath;
  switch (props.failure) {
    case "binary_file":
      return `Cannot open '${path}' because it is not a UTF-8 text file.`;
    case "path_not_file":
      return `Cannot open '${path}' because it is not a regular file.`;
    case "stale_file":
      return `Cannot save '${path}' because it changed in the workspace. Reload it before editing again.`;
    case "workspace_not_owned_by_thread":
      return `Cannot ${action} '${path}' because the workspace does not belong to this thread.`;
    case "workspace_path_outside_root":
    case "resolved_path_outside_root":
      return `Cannot ${action} '${path}' because it resolves outside the project.`;
    case "operation_failed":
      return `Failed to ${action} workspace file '${path}'.`;
  }
}

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? projectFileFailureMessage("read", props),
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String.check(Schema.isMaxLength(PROJECT_FILE_CONTENT_MAX_LENGTH)),
  expectedRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? projectFileFailureMessage("write", props),
    } as any);
  }
}
