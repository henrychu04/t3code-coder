import type { RepositoryIdentity } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

export interface GitLabMergeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

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
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host: url.hostname.toLowerCase(), repository: repository.toLowerCase(), number }
    : null;
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
    const canonicalHost = identity.canonicalKey.split("/")[0]?.toLowerCase();
    return repository?.toLowerCase() === link.repository && canonicalHost === link.host;
  });
}

/** Builds a GitHub URL that remains available when the pull request API cannot be read. */
export function gitHubPullRequestBrowserUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider !== "github" || !Number.isSafeInteger(number) || number < 1) return null;
  const repositoryPath = repository.split("/");
  if (
    repositoryPath.length !== 2 ||
    repositoryPath.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }

  let origin: string | null = null;
  if (identity.locator.source === "git-remote") {
    try {
      const remoteUrl = new URL(identity.locator.remoteUrl.trim());
      if (remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:") {
        origin = remoteUrl.origin;
      }
    } catch {
      // SCP-style remotes are read from their normalized identity below.
    }
  }
  const hostname = identity.canonicalKey.split("/")[0];
  if (origin === null && !hostname) return null;

  try {
    const url = new URL(origin ?? `https://${hostname}`);
    url.pathname = `/${repositoryPath.join("/")}/pull/${number}`;
    return url.toString();
  } catch {
    return null;
  }
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
  const repositoryPath =
    /^(.*?)\/-\/merge_requests\/\d+(?:\/|$)/iu.exec(url.pathname)?.[1] ??
    /^(.*?)(?:\/pull\/\d+|\/-\/merge_requests\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)(?:\/|$)/iu.exec(
      url.pathname,
    )?.[1];
  if (!repositoryPath) return null;
  url.pathname = repositoryPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}
