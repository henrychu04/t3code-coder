import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { readProject, readThreadShell } from "../state/entities";
import { gitLabMergeRequestBrowserUrl, parseGitLabMergeRequestUrl } from "./openPullRequestLink";

/** Read only existing browser state; copying must not start a workspace query. */
export function readThreadReference(ref: ScopedThreadRef): string {
  const panel = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
  if (panel?.kind === "pull-request") {
    const project = readProject(
      scopeProjectRef(
        EnvironmentId.make(panel.environmentId ?? ref.environmentId),
        ProjectId.make(panel.projectId),
      ),
    );
    const url = gitLabMergeRequestBrowserUrl(
      project?.repositoryIdentity,
      panel.repository,
      panel.number,
    );
    if (url) return url;
  }
  const linked = readThreadShell(ref)?.linkedPullRequest;
  return linked && parseGitLabMergeRequestUrl(linked.url) ? linked.url : ref.threadId;
}
