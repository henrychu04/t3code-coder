/**
 * The source control host definitions web and mobile ship, and the one lookup they use.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package with a
 * `./client/definition` entry and adding it here; clients then label, list, and check out its
 * change requests without further branches.
 *
 * @module client-runtime/sourceControlClients
 */
import { makeSourceControlClientRegistry } from "@t3tools/source-control-core/client/definition";

export {
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestTerminology,
  type SourceControlClientDefinition,
} from "@t3tools/source-control-core/client/definition";
import * as GitLab from "@t3tools/source-control-gitlab/client/definition";

/**
 * Coder: GitLab is the only hosted source control provider, so it is the only definition. A
 * repository that has not reported its host yet reads as GitLab, and every other kind reads as
 * the generic host.
 */
const BUILT_IN_SOURCE_CONTROL_CLIENTS = [GitLab.definition];

/** `definitions` lists the built-in hosts in that order, for pickers that offer every host. */
export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
);
