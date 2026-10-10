/**
 * GitLab's client definition. Browser- and React Native-safe.
 *
 * @module source-control-gitlab/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const CHECKOUT_COMMAND = /^glab\s+mr\s+checkout\s+(.+)$/i;
// Coder: GitLab is the only hosted provider, so a merge request URL on any host is accepted;
// self-hosted GitLab hostnames need not contain "gitlab".
const CHANGE_REQUEST_REFERENCE = /^https?:\/\/[^/\s]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;

const KIND = SourceControlProviderKind.make("gitlab");

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "GitLab",
  pickerLabel: "GitLab",
  icon: "gitlab",
  changeRequest: { shortLabel: "MR", singular: "merge request" },
  repositoryPathHint: "group/project",
  publicHost: "gitlab.com",
  publishDescription: "gitlab.com",
  publishHost: () => "gitlab.com",
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/-/merge_requests/${number}`,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `glab mr checkout ${number}`,
  // Coder: GitLab profiles live at the host root, and the web autolinks `!123`, `#123`, and
  // commit SHAs below the repository with GitLab's `/-/` routes (`pullRequestMarkdown.logic.ts`).
  authorProfileUrl: (login, repositoryUrl) =>
    login.endsWith("[bot]")
      ? null
      : new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  referenceAutolinkRepositoryUrl: (repositoryUrl) => repositoryUrl,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/-/merge_requests/"),
});
