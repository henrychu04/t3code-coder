import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, type MouseEvent } from "react";
import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { useNavigate } from "@tanstack/react-router";
import { useProjects, useServerConfigs } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useRightPanelStore } from "../rightPanelStore";
import { useOpenLink } from "../browser/useOpenLink";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
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

/** Only known GitLab hosts may open external markdown links. */
export function isGitLabExternalUrl(
  targetUrl: string,
  projects: ReadonlyArray<Pick<EnvironmentProject, "repositoryIdentity">>,
): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
    return false;
  return (
    url.hostname === "gitlab.com" ||
    projects.some(
      ({ repositoryIdentity }) =>
        repositoryIdentity?.provider === "gitlab" &&
        pullRequestHostOf(repositoryIdentity, "gitlab") === url.hostname.toLowerCase(),
    )
  );
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

type ProjectIdentity = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

export function findProjectForGitLabMergeRequest<P extends ProjectIdentity>(
  projects: ReadonlyArray<P>,
  link: GitLabMergeRequestLink,
): P | undefined {
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

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">>;
  pullRequestsEnabled: boolean;
  url: string;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const project = findProjectForChangeRequest(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    parsed,
  );
  if (project === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: project.id,
      host: parsed.host,
      repository: sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository,
      number: parsed.number,
    },
  };
}

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return useMemo(
    () =>
      resolvePullRequestPreviewTarget({
        environmentId,
        projects,
        pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
        url,
      }),
    [environmentId, projects, serverConfig, url],
  );
}

/** Builds a GitLab URL that remains available when the pull request API cannot be read. */
export function gitLabMergeRequestBrowserUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (
    !identity ||
    (identity.provider !== "gitlab" && identity.provider !== "unknown") ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    return null;
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
        if (!remotePath.toLowerCase().endsWith(suffix.toLowerCase())) return null;
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

export function findProjectOnChangeRequestHost<P extends ProjectIdentity>(
  projects: ReadonlyArray<P>,
  link: ChangeRequestLink,
): P | undefined {
  return (
    findProjectForChangeRequest(projects, link) ??
    projects.find(
      ({ repositoryIdentity }) =>
        repositoryIdentity?.provider === "gitlab" &&
        pullRequestHostOf(repositoryIdentity, "gitlab") === link.host,
    )
  );
}

/**
 * Upstream's modifier rule: cmd/ctrl+click leaves a change-request link to the browser.
 */
export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey">,
): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * Upstream's change-request opener with GitLab-only matching. Opens a merge request link on the
 * page and says whether it did; anything else is left to the caller as an ordinary link.
 *
 * Given a thread, the link opens beside it in the right panel. Without one it opens the merge
 * requests page. Coder has no primary environment, so the page resolves the link against every
 * workspace that reads merge requests, in project order.
 */
export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  return useCallback(
    (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
      if (shouldOpenPullRequestExternally(event)) return false;
      const resolvedThreadRef = targetThreadRef ?? threadRef;
      const resolvedPanelRef = panelRef ?? resolvedThreadRef;
      const parsed = parseChangeRequestUrl(targetUrl);
      if (parsed === null) return false;
      const reads = (environmentId: EnvironmentId) =>
        serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
      // Beside a thread the panel reads on that thread's environment; the page lists them all.
      const projects = resolvedThreadRef
        ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
        : targetEnvironmentId
          ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
          : allProjects.filter((project) => reads(project.environmentId));
      const exactProject = findProjectForChangeRequest(projects, parsed);
      const project =
        exactProject ??
        (resolvedPanelRef
          ? findProjectOnChangeRequestHost(
              projects.filter(
                (candidate) =>
                  serverConfigs.get(candidate.environmentId)?.environment.capabilities
                    .threadPullRequests === true,
              ),
              parsed,
            )
          : undefined);
      if (project === undefined || !reads(project.environmentId)) return false;
      const repository =
        serverConfigs.get(project.environmentId)?.environment.capabilities.threadPullRequests ===
        true
          ? parsed.repository
          : (sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository);
      event.preventDefault();
      event.stopPropagation();
      if (resolvedPanelRef) {
        useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
          // The standalone MR panel has a synthetic ref; each tab keeps its real environment.
          ...(resolvedPanelRef.environmentId === project.environmentId
            ? {}
            : { environmentId: project.environmentId }),
          projectId: project.id,
          ...(serverConfigs.get(project.environmentId)?.environment.capabilities
            .threadPullRequests === true
            ? { host: parsed.host }
            : {}),
          repository,
          url: targetUrl,
          number: parsed.number,
        });
        if (!resolvedThreadRef) {
          void navigate({
            to: "/pull-requests",
            search: (previous) => ({
              ...previous,
              involvement: previous.involvement ?? "all",
              state: previous.state ?? "all",
              repository,
              number: parsed.number,
              selectedHost: parsed.host,
              selectedProjectId: project.id,
              selectedEnvironmentId: project.environmentId,
            }),
            replace: true,
          });
        }
        return true;
      }
      void navigate({
        to: "/pull-requests",
        search: {
          involvement: "all",
          state: "all",
          repository,
          number: parsed.number,
          selectedHost: parsed.host,
          selectedProjectId: project.id,
          selectedEnvironmentId: project.environmentId,
        },
      });
      return true;
    },
    [allProjects, navigate, panelRef, serverConfigs, threadRef],
  );
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
      event.stopPropagation();
      const openInBrowser = shouldOpenPullRequestExternally(event);
      const isAnchor =
        event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
      // A real link already knows how to cmd/ctrl+click. Leave its default
      // action alone so the browser opens the host. Buttons have no href, so
      // they still go through openExternal.
      if (openInBrowser && isAnchor) return false;

      event.preventDefault();
      if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

      // No project to show it in, so it is an ordinary link for the system browser.
      void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open merge request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return false;
    },
    [openChangeRequest, openLink],
  );
}
