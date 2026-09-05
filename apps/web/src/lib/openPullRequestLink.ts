import {
  pullRequestHostOf,
  type RepositoryIdentity,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

export interface GitLabMergeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export type ChangeRequestLink = GitLabMergeRequestLink;

export async function openPullRequestLink(
  shell: { readonly openExternal: (url: string) => Promise<void> },
  url: string,
): Promise<void> {
  await shell.openExternal(url);
}

export function parseGitLabMergeRequestUrl(targetUrl: string): GitLabMergeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
    return null;
  const match = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host: url.hostname.toLowerCase(), repository: repository.toLowerCase(), number }
    : null;
}

export const parseChangeRequestUrl = parseGitLabMergeRequestUrl;

/** Match a stored MR without requiring its project to remain available. */
export function matchesLinkedPullRequestUrl(
  linkedPullRequest: ThreadLinkedPullRequest,
  targetUrl: string,
): boolean {
  const linked = parseGitLabMergeRequestUrl(linkedPullRequest.url);
  const target = parseGitLabMergeRequestUrl(targetUrl);
  return (
    linked !== null &&
    target !== null &&
    linked.host === target.host &&
    linked.repository === target.repository &&
    linked.number === target.number
  );
}

export function findProjectForGitLabMergeRequest(
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">>,
  link: GitLabMergeRequestLink,
): Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity"> | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity || (identity.provider !== "gitlab" && identity.provider !== "unknown")) {
      return false;
    }
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    const canonicalHost = pullRequestHostOf(identity, "gitlab");
    return repository?.toLowerCase() === link.repository && canonicalHost === link.host;
  });
}

export const findProjectForChangeRequest = findProjectForGitLabMergeRequest;

/** Builds a GitLab URL that remains available when the pull request API cannot be read. */
export function gitLabMergeRequestBrowserUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider !== "gitlab" || !Number.isSafeInteger(number) || number < 1) return null;
  const repositoryPath = repository.split("/");
  if (
    repositoryPath.length < 2 ||
    repositoryPath.some(
      (segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment) || segment === "." || segment === "..",
    )
  ) {
    return null;
  }

  let origin: string | null = null;
  let basePath = "";
  if (identity.locator.source === "git-remote") {
    try {
      const remoteUrl = new URL(identity.locator.remoteUrl.trim());
      if (remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:") {
        origin = remoteUrl.origin;
        const remotePath = remoteUrl.pathname.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
        const suffix = `/${repository}`;
        if (!remotePath.endsWith(suffix)) return null;
        basePath = remotePath.slice(0, -suffix.length);
      }
    } catch {
      // SCP-style remotes are read from their normalized identity below.
    }
  }
  const hostname = identity.canonicalKey.split("/")[0];
  if (origin === null && (!hostname || !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(hostname))) return null;

  try {
    const url = new URL(origin ?? `https://${hostname}`);
    url.pathname = `${basePath}/${repositoryPath.join("/")}/-/merge_requests/${number}`;
    return url.toString();
  } catch {
    return null;
  }
}

/** Preserve the deployment's path prefix; never assume gitlab.com. */
export function gitLabAuthorProfileUrl(
  targetUrl: string,
  repository: string,
  login: string,
): string | null {
  if (!/^[A-Za-z0-9_.-]+$/u.test(login) || login === "." || login === "..") return null;
  if (!parseGitLabMergeRequestUrl(targetUrl)) return null;
  const url = new URL(targetUrl);
  const suffix = `/${repository}/-/merge_requests/`;
  const index = url.pathname.lastIndexOf(suffix);
  if (index < 0) return null;
  url.pathname = `${url.pathname.slice(0, index)}/${encodeURIComponent(login)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The repository root behind a recognized change-request URL. */
export function changeRequestRepositoryUrl(targetUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const repositoryPath = /^(.*?)\/-\/merge_requests\/\d+(?:\/|$)/iu.exec(url.pathname)?.[1];
  if (!repositoryPath) return null;
  url.pathname = repositoryPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}
