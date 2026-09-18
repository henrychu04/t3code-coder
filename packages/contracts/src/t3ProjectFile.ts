import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { ProjectScriptIcon } from "./orchestration.ts";

export const T3_PROJECT_FILE_NAME = "t3.json";
export const T3ProjectFileScript = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  icon: Schema.optionalKey(ProjectScriptIcon),
  runOnWorktreeCreate: Schema.optionalKey(Schema.Boolean),
  async: Schema.optionalKey(Schema.Boolean),
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;
export const T3ProjectFile = Schema.Struct({
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  scripts: Schema.optionalKey(Schema.Array(T3ProjectFileScript).check(Schema.isMaxLength(50))),
});
export type T3ProjectFile = typeof T3ProjectFile.Type;
export const ProjectGetConfigInput = Schema.Struct({ projectId: ProjectId });
export const ProjectGetConfigResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("valid"), file: T3ProjectFile }),
  Schema.Struct({
    status: Schema.Literals(["missing", "invalid", "unavailable"]),
    file: Schema.Null,
  }),
]);
export type ProjectGetConfigResult = typeof ProjectGetConfigResult.Type;
