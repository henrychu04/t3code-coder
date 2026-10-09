import { ProjectId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  CommandId,
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  type UnknownUnionMember,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_TEXT_SEARCH_MAX_LIMIT = 500;
export const PROJECT_SEARCH_INPUT_MAX_LENGTH = 256;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_CONTENT_MAX_LENGTH = 1024 * 1024;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /** Run in the thread's worktree each time the thread settles. */
  runOnSettle: Schema.optional(Schema.Boolean),
  /** Start the agent while setup runs unless explicitly disabled. */
  async: Schema.optional(Schema.Boolean),
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
/** A workspace-relative image a project may use as its favicon. */
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

/** A project's chosen icon, as clients set it. */
export const ProjectIconOverride = Schema.Union([
  ProjectLucideIcon,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

/**
 * Before v2, servers sent a monogram as a lucide icon carrying its text, so
 * older clients showed a folder. Icons stored then, and v2 servers released
 * before this change, still use that shape; it is read here, never written.
 */
const ProjectLucideIconWithLegacyMonogram = Schema.Struct({
  ...ProjectLucideIcon.fields,
  monogramText: Schema.optional(ProjectMonogramText),
  monogram: Schema.optional(ProjectMonogramText),
});
const projectIconMembers = [
  ProjectLucideIconWithLegacyMonogram,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
] as const;
type ProjectIconMember = (typeof projectIconMembers)[number]["Type"];

const fromLegacyMonogram = (icon: ProjectIconMember): ProjectIconOverride => {
  if (icon.kind !== "lucide") return icon;
  const text = icon.monogramText ?? icon.monogram;
  return text === undefined
    ? { kind: "lucide", name: icon.name, color: icon.color }
    : { kind: "monogram", text, color: icon.color };
};

/** An icon the server stores; it reads legacy monograms and writes the plain shape. */
export const StoredProjectIcon = Schema.Union(projectIconMembers).pipe(
  Schema.decodeTo(
    Schema.toType(ProjectIconOverride),
    SchemaTransformation.transform<ProjectIconOverride, ProjectIconMember>({
      decode: fromLegacyMonogram,
      encode: (icon) => icon,
    }),
  ),
);

/**
 * An icon as clients receive it. A kind from a newer server decodes as no
 * override, so the client shows the project's default icon.
 */
export const ReceivedProjectIcon = ForwardCompatibleUnion(projectIconMembers, "kind").pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.toType(ProjectIconOverride)),
    SchemaTransformation.transform<
      ProjectIconOverride | null,
      ProjectIconMember | UnknownUnionMember<"kind">
    >({
      decode: (icon) => (isUnknownUnionMember(icon) ? null : fromLegacyMonogram(icon)),
      encode: (icon) => icon as ProjectIconMember,
    }),
  ),
);

export const Project = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ReceivedProjectIcon)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Project = typeof Project.Type;

export const ProjectSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
  updatedAt: IsoDateTime,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("project.upserted"), project: Project }),
  Schema.Struct({
    type: Schema.Literal("project.deleted"),
    projectId: ProjectId,
    deletedAt: IsoDateTime,
  }),
]);
export type ProjectChange = typeof ProjectChange.Type;

export const ProjectCreatePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.Type;

export const ProjectUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autoPull: Schema.optional(Schema.Boolean),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectUpdatePayload = typeof ProjectUpdatePayload.Type;

export const ProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.create"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectCreatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.update"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.delete"),
    commandId: CommandId,
    projectId: ProjectId,
    force: Schema.optional(Schema.Boolean),
  }),
]);
export type ProjectMutation = typeof ProjectMutation.Type;

export class ProjectMutationError extends Schema.TaggedError<ProjectMutationError>()(
  "ProjectMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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
  ignored: Schema.optional(Schema.Boolean),
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
/** Coder: upstream's name for a content-search match, used by its search dialog. */
export type ProjectContentMatch = ProjectTextSearchMatch;

export const ProjectTextSearchResult = Schema.Struct({
  nextCursor: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  matches: Schema.Array(ProjectTextSearchMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type ProjectTextSearchResult = typeof ProjectTextSearchResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  directoryPath: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  ),
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

export class WorkspaceListDirectoriesError extends Schema.TaggedError<WorkspaceListDirectoriesError>()(
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

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
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

export class ProjectTextSearchError extends Schema.TaggedError<ProjectTextSearchError>()(
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

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
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

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
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

/** The environment's Scratch project, created on first request. */
export const ProjectEnsureScratchResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectEnsureScratchResult = typeof ProjectEnsureScratchResult.Type;

/** A project started from just a name, in a new folder the server makes. */
export const ProjectCreateNewInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ProjectCreateNewInput = typeof ProjectCreateNewInput.Type;

export const ProjectCreateNewResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** Why the first commit failed. The project and its files exist either way. */
  commitError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectCreateNewResult = typeof ProjectCreateNewResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
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
