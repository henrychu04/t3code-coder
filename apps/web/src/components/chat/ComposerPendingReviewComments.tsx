import { MessageCircle, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { cn } from "~/lib/utils";

interface ComposerPendingReviewCommentsProps {
  comments: ReadonlyArray<ReviewCommentContext>;
  onRemove: (commentId: string) => void;
  className?: string;
}

export function ComposerPendingReviewComments({
  comments,
  onRemove,
  className,
}: ComposerPendingReviewCommentsProps) {
  if (comments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {comments.map((comment) => {
        const label = `${comment.filePath} ${comment.rangeLabel}`;
        const chip = (
          <ContextChip
            key={comment.id}
            kind="review-comment"
            tabIndex={comment.text.length === 0 ? undefined : 0}
            className="pr-[0.25em]"
          >
            <MessageCircle />
            <ContextChipLabel>{label}</ContextChipLabel>
            <ContextChipAction
              aria-label={`Remove comment on ${label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(comment.id);
              }}
            >
              <X aria-hidden />
            </ContextChipAction>
          </ContextChip>
        );
        if (comment.text.length === 0) return chip;
        return (
          <Tooltip key={comment.id}>
            <TooltipTrigger render={chip} />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
              {comment.text}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
