import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";

// Coder: GitCafe is not carried. Upstream's helper rewrites only GitCafe links and returns every
// other URL unchanged, so it is the identity here and its callers stay upstream's.
export const canonicalizeGitCafePullRequestUrl = (value: string): string => value;

/**
 * The server and every client read hosts through this one registry, so they agree on which host
 * owns a URL or remote.
 *
 * Coder: GitLab is the only hosted source-control provider, so it is the only definition, and a
 * repository that has not reported its host reads as GitLab.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry([
  GitLab.definition,
]);
