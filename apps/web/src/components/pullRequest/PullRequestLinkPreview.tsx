import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useState, type ReactElement } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

/**
 * A hover card for a known merge request link. The link keeps its own click behavior; the card
 * reads the merge request's preview through the workspace helper only once it opens.
 */
export function PullRequestLinkPreview({
  link,
  target,
}: {
  link: ReactElement;
  target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef };
}) {
  const [open, setOpen] = useState(false);
  const previewQuery = useEnvironmentQuery(
    open
      ? pullRequestEnvironment.preview({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  const preview = previewQuery.data;
  const state =
    preview === null
      ? null
      : resolvePullRequestState({ state: preview.state, isDraft: preview.isDraft });
  const authorLabel =
    preview === null
      ? null
      : preview.author === null
        ? "ghost"
        : preview.author.name && preview.author.name !== preview.author.login
          ? `${preview.author.name} (@${preview.author.login})`
          : preview.author.login;

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={link} delay={350} closeDelay={120} />
      {preview === null ? null : (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="min-w-0 p-3">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">{preview.repository}</span>
              <span className="shrink-0">!{preview.number}</span>
              {state === null ? null : (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                    {state.label}
                  </span>
                </>
              )}
            </div>
            <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
              {preview.title}
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <PullRequestActorAvatar actor={preview.author} className="size-4" />
              <span className="min-w-0 truncate">{authorLabel}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">opened {formatRelativeTimeLabel(preview.createdAt)}</span>
            </div>
          </div>
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}
