import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

/**
 * Upstream's change-request body renderer: recognized GitLab navigation stays internal, videos play
 * inline from their host, and other uploads open there. Relative GitLab uploads resolve against the
 * repository's host. Coder has no GitHub credential-backed media fetch.
 */
export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  threadRef,
  hostUrl,
  className,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  /** Thread the body is shown beside, so its merge request links open in that thread's panel. */
  threadRef?: ScopedThreadRef | null;
  /** Overrides the context's repository as the origin of relative GitLab uploads. */
  hostUrl?: string | null;
  className?: string;
}) {
  const context = useContext(PullRequestMarkdownContext);
  const repositoryUrl = context?.repositoryUrl ?? null;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const segments = splitPullRequestBody(text, hostUrl ?? repositoryUrl);
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkPullRequestAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <div
      className={cn(
        "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
        className,
      )}
    >
      {segments.map((segment) => {
        if (segment.kind === "markdown") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.text}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={resolvedThreadRef}
              pullRequestPanelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
              extraRemarkPlugins={extraRemarkPlugins}
            />
          );
        }
        if (segment.media === "video") {
          return (
            <MediaVideoPlayer
              key={`${segment.id}:${segment.url}`}
              src={segment.url}
              originalUrl={segment.url}
              label="Merge request video"
              className="w-full"
              videoClassName="rounded-lg border border-border/60"
            />
          );
        }
        return (
          <a
            key={segment.id}
            href={segment.url}
            rel="noreferrer noopener"
            target="_blank"
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
          >
            <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Open attachment on {segment.hostLabel}</span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
