import type { ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import { parseGitLabMergeRequestUrl } from "~/lib/openPullRequestLink";

/** Infer relationships only among this thread's linked MRs on the selected GitLab host. */
export function linkedGitLabStack(links: ReadonlyArray<ThreadPullRequestLink>, currentUrl: string) {
  const current = parseGitLabMergeRequestUrl(currentUrl);
  if (!current) return null;
  const valid = links.filter((link) => {
    const parsed = parseGitLabMergeRequestUrl(link.url);
    return (
      parsed !== null &&
      parsed.host === current.host &&
      parsed.repository === current.repository &&
      threadPullRequestKeyOf(parsed) === threadPullRequestKeyOf(link)
    );
  });
  const key = threadPullRequestKeyOf(current);
  const chain = resolveThreadPullRequestChains(valid).find(
    (entry) =>
      entry.layers.length > 1 && entry.layers.some((link) => threadPullRequestKeyOf(link) === key),
  );
  if (!chain) return null;
  return {
    ...chain,
    position: chain.layers.findIndex((link) => threadPullRequestKeyOf(link) === key) + 1,
  };
}
