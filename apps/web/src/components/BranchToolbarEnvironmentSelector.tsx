import { ThreadDetailsSelectControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

// Coder: every workspace is a remote Coder machine and there is no automatic placement.
interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  displayMode?: "toolbar" | "panel";
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  displayMode = "toolbar",
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        <CloudIcon
          className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <ComposerContextLabel displayMode={displayMode}>
          {activeEnvironment?.label ?? "Run on"}
        </ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsSelectControl
              panel={displayMode === "panel"}
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          <CloudIcon
            className={
              displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
            }
          />
          <ComposerContextLabel displayMode={displayMode}>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...(displayMode === "toolbar" ? composerFloatingLayerProps : {})}
        {...(displayMode === "panel"
          ? {
              className: "w-(--anchor-width)",
            }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <CloudIcon className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
