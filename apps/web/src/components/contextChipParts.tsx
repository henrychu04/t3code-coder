import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { CONTEXT_INLINE_CHIP_FOCUS_CLASS_NAME } from "./composerInlineChip";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";

export function ContextChipPopover(props: {
  copyMarkdown?: string;
  accessibleLabel: string;
  chip: ReactNode;
  children: ReactNode;
  triggerClassName?: string;
  popupClassName?: string;
  viewportClassName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="chip"
            className={cn(
              "inline-flex max-w-full cursor-pointer items-center rounded-[0.5em] align-middle",
              CONTEXT_INLINE_CHIP_FOCUS_CLASS_NAME,
              props.triggerClassName,
            )}
            aria-label={`${props.accessibleLabel}. Show details`}
            data-markdown-copy={props.copyMarkdown}
          />
        }
      >
        {props.chip}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        className={cn("w-[min(36rem,calc(100vw-2rem))]", props.popupClassName)}
        viewportClassName={cn("overflow-x-auto p-2", props.viewportClassName)}
      >
        <PopoverTitle className="sr-only">{props.accessibleLabel}</PopoverTitle>
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}
