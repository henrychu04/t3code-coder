import { PaperclipIcon, PlayIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  panelRef?: ScopedThreadRef | undefined;
}>({ repositoryUrl: null });

/** MR markdown keeps recognized GitLab navigation internal and external media inert. */
export function PullRequestMarkdown({
  text,
  hostUrl,
  cwd,
  environmentId,
  className,
}: {
  text: string;
  hostUrl: string | null;
  cwd: string;
  environmentId: EnvironmentId;
  className?: string;
}) {
  const segments = splitPullRequestBody(text, hostUrl);
  const { repositoryUrl, panelRef } = useContext(PullRequestMarkdownContext);
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkPullRequestAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <div className={cn("space-y-3", className)}>
      {segments.map((segment) => {
        if (segment.kind === "markdown") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.text}
              cwd={cwd}
              environmentId={environmentId}
              panelRef={panelRef}
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
