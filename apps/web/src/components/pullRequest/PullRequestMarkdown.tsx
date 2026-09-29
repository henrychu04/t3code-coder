import { PaperclipIcon, PlayIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

/**
 * Upstream's change-request body renderer with Coder's media rule: recognized GitLab navigation
 * stays internal, and uploads render as inert attachment rows rather than fetched media. Relative
 * GitLab uploads resolve against the repository's host.
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
              panelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
              extraRemarkPlugins={extraRemarkPlugins}
            />
          );
        }
        const isVideo = segment.media === "video";
        const Icon = isVideo ? PlayIcon : PaperclipIcon;
        return (
          <div
            key={segment.id}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {isVideo
                ? `Video attachment on ${segment.hostLabel}`
                : `Attachment on ${segment.hostLabel}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
