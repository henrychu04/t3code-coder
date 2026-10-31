import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

// Coder: every workspace is reached through the gateway's Coder CLI connection, so there are no
// routes, T3 Connect, WSL, or SSH targets to name.
export function environmentTransportLabel(_environment: EnvironmentPresentation): string {
  return "Coder workspace";
}

// Coder: the label never depends on the prepared connection target.
export function useEnvironmentTransportLabel(environment: EnvironmentPresentation): string {
  return environmentTransportLabel(environment);
}

export function EnvironmentTransportLabel(props: {
  readonly environment: EnvironmentPresentation;
}) {
  return useEnvironmentTransportLabel(props.environment);
}

export function EnvironmentRow({
  kind,
  label,
  subtitle,
  below,
  detail,
  dimmed = false,
  className,
  children,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly label: string;
  readonly subtitle: ReactNode;
  readonly below?: ReactNode;
  readonly detail?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4",
        className,
      )}
    >
      {/* Dim only identity so switched-off controls remain readable and distinct from disabled controls. */}
      <EnvironmentMachineIcon
        aria-hidden
        kind={kind}
        className={cn("size-4 text-muted-foreground", dimmed && "opacity-60")}
      />
      <div className={cn("min-w-0", dimmed && "opacity-60")}>
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
      {detail ? <div className="col-span-2 col-start-2 min-w-0">{detail}</div> : null}
    </div>
  );
}
