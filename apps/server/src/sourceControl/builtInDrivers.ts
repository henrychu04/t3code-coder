import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

// Coder: GitLab is the only hosted provider.
const drivers = [GitLabDriver.driver];

export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

// Coder: only GitLab's services are provided.
export const layer = GitLabPullRequestCli.layer.pipe(
  Layer.provideMerge(GitLabCli.layer),
  Layer.provideMerge(ServerSourceControlHost.layer),
);
