/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

// Coder: GitLab is the only hosted provider.
const drivers = [GitLabDriver.driver];

/** Every service a built-in driver's `make` needs; the server's layers must provide them all. */
export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

/** Ordered as the hosts appear in discovery. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

/** The services the built-in drivers' packages own, plus the host port they all run against. */
// Coder: only GitLab's services are provided.
export const layer = GitLabPullRequestCli.layer.pipe(
  Layer.provideMerge(GitLabCli.layer),
  Layer.provideMerge(ServerSourceControlHost.layer),
);
