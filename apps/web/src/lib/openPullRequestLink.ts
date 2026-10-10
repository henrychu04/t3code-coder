import type {
  EnvironmentId,
  PullRequestRef,
  RepositoryIdentity,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useMemo } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  parseChangeRequestUrl as parseHostedChangeRequestUrl,
  type ChangeRequestLink,
} from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { useOpenLink } from "../browser/useOpenLink";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useProjects, useServerConfigs } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";

export {
  type ChangeRequestLink,
  gitHubPullRequestBrowserUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  matchesLinkedPullRequestUrl,
  changeRequestRepositoryUrl,
} from "@t3tools/shared/changeRequestUrl";

/**
 * Coder: only a URL a shipped host definition claims is a change request here, so with GitLab the
 * only host, other hosts' pull request links stay ordinary links.
 */
export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  return sourceControlClients.findByChangeRequestUrl(targetUrl) === undefined
    ? null
    : parseHostedChangeRequestUrl(targetUrl);
}

/**
 * Coder: merge requests are read through the workspace's GitLab CLI, so only GitLab checkouts
 * (including self-hosted remotes whose provider could not be named) can resolve a link. The
 * registry reads every other kind as the generic host, which would still match by host and path.
 */
function isGitLabProject(project: EnvironmentProject): boolean {
  const provider = project.repositoryIdentity?.provider;
  return provider === "gitlab" || provider === "unknown";
}

/**
 * The project a link belongs to, or nothing. Matched the way the server matches: the repository
 * identity is the full path below the host where one was recorded — which is what nested GitLab
 * groups and Azure project paths need — and the host is the first segment of the canonical
 * remote, so github.com and an Enterprise install stay apart.
 */
export function findProjectForChangeRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return projects.filter(isGitLabProject).find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link)
    );
  });
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
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
      host: parsed.authority ?? parsed.host,
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

/**
 * Coder: GitLab's counterpart of `gitHubPullRequestBrowserUrl`. It keeps a self-hosted install's
 * origin and path prefix rather than assuming `https://{host}/`.
 */
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

/**
 * Any project checked out from the link's host. Thread links are host-level, so a pull request
 * from a repository nobody has checked out is still linkable as long as one project on that
 * host can lend the server its credentials. The link's own project, when it exists, comes first.
 */
export function findProjectOnChangeRequestHost(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  const own = findProjectForChangeRequest(projects, link);
  if (own !== undefined) return own;
  return projects.filter(isGitLabProject).find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
    );
  });
}

/**
 * Opens a change request link on the page, and says whether it did. Anything else — another
 * organisation's repository, a host nothing here is checked out from, a link that merely looks
 * like one — is left alone for the caller to handle as the ordinary link it is.
 *
 * Resolving the project here rather than on the page is what makes recognising a URL safe: a
 * lookalike hostname matches no project and stays a link, and the page is handed the project
 * rather than a host to narrow its whole list by.
 *
 * Given a thread, the link opens beside it in the right panel instead of taking the whole app to
 * the pull requests page: a reader following a link the agent wrote is reading the thread, and
 * should still be reading it afterwards. Any change request opens there, not only the thread's
 * own, since the panel is told which one to show.
 */
export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey">,
): boolean {
  return event.metaKey || event.ctrlKey;
}

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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
      if (shouldOpenPullRequestExternally(event)) return false;
      const resolvedThreadRef = targetThreadRef ?? threadRef;
      const resolvedPanelRef = panelRef ?? resolvedThreadRef;
      const parsed = parseChangeRequestUrl(targetUrl);
      if (parsed === null) return false;
      const reads = (environmentId: string) =>
        serverConfigs.get(environmentId as EnvironmentId)?.environment.capabilities.pullRequests ===
        true;
      // Beside a thread the panel reads on that thread's environment, so a project from another
      // one could not be read there whatever its remote says: two environments can hold the same
      // repository, and handing the panel the wrong one's id opens a surface that never loads.
      //
      // The page has no such tie — it lists every server at once — so the link is resolved
      // against all of them, the primary first where two hold the same repository.
      const projects = resolvedThreadRef
        ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
        : targetEnvironmentId
          ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
          : allProjects
              .filter((project) => reads(project.environmentId))
              .toSorted(
                (left, right) =>
                  Number(right.environmentId === primaryEnvironmentId) -
                  Number(left.environmentId === primaryEnvironmentId),
              );
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
          // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
          ...(resolvedPanelRef.environmentId === project.environmentId
            ? {}
            : { environmentId: project.environmentId }),
          projectId: project.id,
          ...(serverConfigs.get(project.environmentId)?.environment.capabilities
            .threadPullRequests === true
            ? { host: parsed.authority ?? parsed.host }
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
              selectedHost: parsed.authority ?? parsed.host,
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
          // Every state, so the pull request being opened is also in the list behind it whether
          // it is open, merged or closed.
          state: "all",
          repository,
          number: parsed.number,
          selectedHost: parsed.authority ?? parsed.host,
          selectedProjectId: project.id,
          // Named so the page opens the right one of two servers holding this project.
          selectedEnvironmentId: project.environmentId,
        },
      });
      return true;
    },
    [allProjects, navigate, panelRef, primaryEnvironmentId, serverConfigs, threadRef],
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
      // action alone so the browser (or Electron's window-open handler) opens
      // the host. Buttons have no href, so they still go through openExternal.
      if (openInBrowser && isAnchor) return false;

      event.preventDefault();
      if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

      // No project to show it in, so it is an ordinary link and follows the
      // "Open links in" setting; the modifier still forces the system browser.
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
