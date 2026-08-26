import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

const GIT_LIST_REFS_MAX_LIMIT = 200;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyString,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyString),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyString.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
});

export const VcsStatusInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_REFS_MAX_LIMIT))),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  newRefName: Schema.optional(TrimmedNonEmptyString),
  baseRefName: Schema.optional(TrimmedNonEmptyString),
  path: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({ refName: TrimmedNonEmptyString });
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

const VcsStatusShape = {
  isRepo: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyString),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;
export const VcsStatusResult = Schema.Struct(VcsStatusShape);
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsRefStatusResult = Schema.Struct({
  isRepo: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsRefStatusResult = typeof VcsRefStatusResult.Type;

export const VcsRefStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { local: VcsRefStatusResult }),
  Schema.TaggedStruct("localUpdated", { local: VcsRefStatusResult }),
]);
export type VcsRefStatusStreamEvent = typeof VcsRefStatusStreamEvent.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { local: VcsStatusLocalResult }),
  Schema.TaggedStruct("localUpdated", { local: VcsStatusLocalResult }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({ worktree: VcsWorktree });
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const VcsRenameThreadBranchInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  expectedBranch: TrimmedNonEmptyString,
  newBranch: TrimmedNonEmptyString,
  renameWorktreeFolder: Schema.Boolean,
});
export type VcsRenameThreadBranchInput = typeof VcsRenameThreadBranchInput.Type;

export const VcsRenameThreadBranchResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsRenameThreadBranchResult = typeof VcsRenameThreadBranchResult.Type;

export class VcsRenameThreadBranchError extends Schema.TaggedErrorClass<VcsRenameThreadBranchError>()(
  "VcsRenameThreadBranchError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitCommandError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;
