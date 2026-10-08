/**
 * Upstream's project favicon resolver.
 *
 * Coder: project favicons are not served (there is no asset URL route and browser storage keeps
 * no favicon cache), so no favicon path is ever resolved.
 *
 * @module project/ProjectFaviconResolver
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ProjectFaviconResolutionError extends Schema.TaggedError<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

export const layer = Layer.succeed(
  ProjectFaviconResolver,
  ProjectFaviconResolver.of({ resolvePath: () => Effect.succeed(null) }),
);
