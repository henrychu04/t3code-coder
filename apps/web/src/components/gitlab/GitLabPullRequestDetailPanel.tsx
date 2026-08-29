import type {
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { GitPullRequest, LoaderCircle } from "lucide-react";
import { useMemo } from "react";

import type { DraftId } from "../../composerDraftStore";
import { gitLabMergeRequestEnvironment } from "../../state/gitLabMergeRequests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { Button } from "../ui/button";

interface GitLabPullRequestDetailPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly repository: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly reference?: PullRequestRef;
}

/**
 * Resolves the active thread branch to its GitLab merge request, then hands the
 * reference to the upstream detail panel. All detail reads and mutations stay
 * on the environment-scoped Coder RPC connection.
 */
function CurrentGitLabPullRequestDetailPanel(props: GitLabPullRequestDetailPanelProps) {
  const currentQuery = useEnvironmentQuery(
    gitLabMergeRequestEnvironment.viewCurrent({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, cwd: props.cwd },
    }),
  );
  const reference = useMemo<PullRequestRef | null>(() => {
    const number = currentQuery.data?.mergeRequest?.number;
    return number === undefined
      ? null
      : { projectId: props.projectId, repository: props.repository, number };
  }, [currentQuery.data?.mergeRequest?.number, props.projectId, props.repository]);

  if (currentQuery.isPending && currentQuery.data === null) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin" />
          Loading GitLab merge request…
        </span>
      </div>
    );
  }

  if (currentQuery.error !== null) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-semibold">Couldn’t load the GitLab merge request</p>
          <p className="mt-2 text-sm text-muted-foreground">{currentQuery.error}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={currentQuery.refresh}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (reference === null) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
        <div>
          <GitPullRequest className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">No merge request on this branch</p>
          <p className="mt-1 text-sm text-muted-foreground">
            GitLab does not report an open merge request for this thread.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PullRequestDetailPanel
      environmentId={props.environmentId}
      reference={reference}
      context="page"
      composerDraftTarget={props.composerDraftTarget}
    />
  );
}

export function GitLabPullRequestDetailPanel(props: GitLabPullRequestDetailPanelProps) {
  if (props.reference) {
    return (
      <PullRequestDetailPanel
        environmentId={props.environmentId}
        reference={props.reference}
        context="page"
        composerDraftTarget={props.composerDraftTarget}
      />
    );
  }
  return <CurrentGitLabPullRequestDetailPanel {...props} />;
}
