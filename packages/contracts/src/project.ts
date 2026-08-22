import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // An empty query is a bounded browse: the index returns frecency-ordered
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
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

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
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
