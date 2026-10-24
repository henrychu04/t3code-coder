import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";

/**
 * In the shared registry's order, which is the order hosts are listed and probed in.
 *
 * Coder: GitLab is the only hosted provider.
 */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [GitLabDriver.driver] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;
