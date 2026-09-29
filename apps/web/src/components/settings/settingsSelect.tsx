import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** A native select for Coder settings forms. */
export function SettingsSelect({
  ariaLabel,
  children,
  id,
  disabled,
  className,
  onChange,
  value,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      id={id}
      disabled={disabled}
      className={cn(
        "h-8 min-w-44 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64",
        className,
      )}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  );
}
