import type { ReactNode } from "react";
import { Undo2Icon } from "lucide-react";

import { cn } from "../../lib/utils";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SettingsPage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
      <WorkspacePageContainer className="gap-10 py-8">{children}</WorkspacePageContainer>
    </div>
  );
}

export function SettingsSection({
  children,
  description,
  title,
  unframed = false,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
  readonly unframed?: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className={cn("px-3 sm:px-4", unframed && "flex min-h-8 items-center")}>
        <h2
          className={cn(
            "text-lg font-semibold tracking-tight",
            unframed && "tracking-[-0.025em] text-foreground",
          )}
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div
        className={
          unframed
            ? "relative space-y-1 overflow-visible text-foreground"
            : "divide-y divide-border/70 rounded-xl border bg-card/40"
        }
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  children,
  className,
  control,
  description,
  resetAction,
  title,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly control?: ReactNode;
  readonly description?: string;
  readonly resetAction?: ReactNode;
  readonly title: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-h-5 items-center gap-1.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {resetAction}
        </div>
        {description ? (
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
        ) : null}
        {children}
      </div>
      {control ? <div className="flex items-center sm:justify-end">{control}</div> : null}
    </div>
  );
}

export function SettingResetButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Reset ${props.label} to default`}
            disabled={props.disabled ?? false}
            size="icon-micro"
            variant="ghost-muted"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsSelect({
  ariaLabel,
  children,
  onChange,
  value,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className="h-8 min-w-44 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  );
}
