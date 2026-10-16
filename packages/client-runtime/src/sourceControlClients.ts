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

export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
);
