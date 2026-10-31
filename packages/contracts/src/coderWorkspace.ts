import * as Schema from "effect/Schema";

const usageStat = <Unit extends "cores" | "B">(unit: Unit) =>
  Schema.Struct({
    used: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Null when the workspace has no limit for this resource. */
    total: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))),
    unit: Schema.Literal(unit),
  });

/** Coder: the workspace's CPU, memory, and home-disk use, as `coder stat` reports them. */
export const CoderWorkspaceResourceUsage = Schema.Struct({
  cpu: usageStat("cores"),
  memory: usageStat("B"),
  disk: usageStat("B"),
});
export type CoderWorkspaceResourceUsage = typeof CoderWorkspaceResourceUsage.Type;

export class CoderWorkspaceResourceUsageError extends Schema.TaggedError<CoderWorkspaceResourceUsageError>()(
  "CoderWorkspaceResourceUsageError",
  { message: Schema.String },
) {}
