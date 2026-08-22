import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

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
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <section className="space-y-3">
      <div className="px-3 sm:px-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="divide-y divide-border/70 rounded-xl border bg-card/40">{children}</div>
    </section>
  );
}

export function SettingsRow({
  children,
  className,
  control,
  description,
  title,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly control?: ReactNode;
  readonly description?: string;
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
        <h3 className="text-sm font-medium">{title}</h3>
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
