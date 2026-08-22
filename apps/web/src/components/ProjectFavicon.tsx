import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "~/lib/utils";

export function ProjectFavicon(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
  readonly className?: string;
  readonly fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const Icon = input.fallbackIcon ?? FolderIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", input.className)} />;
}
