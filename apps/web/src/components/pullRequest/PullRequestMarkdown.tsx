import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { resolveGitLabUploadUrl } from "@t3tools/client-runtime/pull-request-markdown";
import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null;
  // Coder: the repository GitLab's project-relative `/uploads/…` links resolve against.
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

type MarkdownUrlNode = { type: string; url?: string; children?: MarkdownUrlNode[] };

const UPLOAD_URL_NODE_TYPES = new Set(["image", "link", "definition"]);

/** Coder: GitLab writes pasted files into Markdown as `/uploads/…` images and links. */
function remarkGitLabUploads(options: { readonly repositoryUrl: string }) {
  const visit = (node: MarkdownUrlNode): void => {
    if (UPLOAD_URL_NODE_TYPES.has(node.type) && node.url !== undefined) {
      node.url = resolveGitLabUploadUrl(node.url, options.repositoryUrl) ?? node.url;
    }
    node.children?.forEach(visit);
  };
  return (tree: MarkdownUrlNode) => visit(tree);
}

/**
 * Upstream's change-request body renderer: recognized GitLab navigation stays internal, videos play
 * inline from their host, and other uploads open there. Relative GitLab uploads resolve against the
 * repository. Coder: no source control host's credentialed media fetch is carried.
 */
export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  threadRef,
  className,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  /** Thread the body is shown beside, so its merge request links open in that thread's panel. */
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const context = useContext(PullRequestMarkdownContext);
  const autolinks = context?.autolinks;
  const repositoryUrl = context?.repositoryUrl ?? null;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const segments = splitPullRequestBody(text, repositoryUrl);
  const extraRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = autolinks
    ? [[remarkPullRequestAutolinks, { autolinks }]]
    : [];
  if (repositoryUrl !== null) extraRemarkPlugins.push([remarkGitLabUploads, { repositoryUrl }]);
  return (
    <div
      className={cn(
        "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
        className,
      )}
      data-image-gallery
    >
      {segments.map((segment) => {
        if (segment.kind === "markdown" || segment.media === "image") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.kind === "markdown" ? segment.text : `![](<${segment.url}>)`}
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
          // Desktop converts blocked _blank navigation to openExternal.
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
