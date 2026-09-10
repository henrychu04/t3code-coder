import {
  pullRequestHostOf,
  type OrchestrationProjectShell,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

/** Links may only name a GitLab host established by workspace project metadata. */
export function isCoderPullRequestLink(
  link: ThreadPullRequestKey & { readonly url: string },
  projects: ReadonlyArray<OrchestrationProjectShell>,
): boolean {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return false;
  }
  if (!/\/-\/merge_requests\/\d+(?:\/|$)/u.test(url.pathname)) return false;
  const parsed = parseChangeRequestUrl(link.url);
  if (
    !parsed ||
    parsed.host !== link.host.toLowerCase() ||
    parsed.repository !== link.repository.toLowerCase() ||
    parsed.number !== link.number
  )
    return false;
  return projects.some(
    ({ repositoryIdentity }) =>
      repositoryIdentity?.provider === "gitlab" &&
      pullRequestHostOf(repositoryIdentity, "gitlab") === parsed.host,
  );
}
