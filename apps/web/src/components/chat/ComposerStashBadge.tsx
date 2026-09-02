import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * Bookmark control that shows the stash count and opens the stash menu. It
 * lives in the composer's bottom toolbar, next to the other controls.
 *
 * On save the badge gives one quiet acknowledgement: it lifts to full
 * opacity and the count ticks over. `pulseKey` changes per stash, remounting
 * the count so the transition replays without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  pulseKey: number;
  pulsing: boolean;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;
  return (
    <Button
      size="micro"
      variant="ghost-muted"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      className={cn(
        "shrink-0 gap-1 px-1.5",
        (props.menuOpen || props.pulsing) &&
          "[--control-icon-color:currentColor] text-foreground",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onToggleMenu}
    >
      <BookmarkIcon className="size-3 shrink-0" aria-hidden="true" />
      <span
        key={props.pulseKey}
        className={cn(
          "text-[10px] font-medium leading-none tabular-nums",
          props.pulsing
            ? "animate-[prompt-stash-count-enter_180ms_ease-out_both] text-primary motion-reduce:animate-none"
            : "text-muted-foreground",
        )}
      >
        {props.count}
      </span>
    </Button>
  );
});
