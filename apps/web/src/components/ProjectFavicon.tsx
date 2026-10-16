// Coder: project icons come from saved metadata or upstream's monograms; workspace favicon
// image reads are not carried.
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectIconOverride } from "@t3tools/contracts";
import { FolderCodeIcon } from "lucide-react";
import { createElement, lazy, Suspense, type ComponentType } from "react";
import { deriveProjectIdentity } from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { ProjectMonogram } from "./ProjectMonogram";
import { cn } from "~/lib/utils";

// All lucide icons load as one chunk, only once a project uses a lucide override.
const LucideProjectIcon = lazy(() =>
  import("../lib/lucideIconByName").then(({ lucideIconByName }) => ({
    default: function LucideProjectIcon(props: { name: string; className: string }) {
      return createElement(lucideIconByName(props.name) ?? FolderCodeIcon, {
        className: props.className,
      });
    },
  })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-inherit" />;
}

/** Upstream metadata icons and monograms, without workspace image reads. */
export type ProjectFaviconProject = Pick<EnvironmentProject, "title" | "workspaceRoot"> &
  Partial<Pick<EnvironmentProject, "environmentId" | "id" | "projectIcon">>;
export function ProjectIconGraphic({
  icon,
  className,
}: {
  icon: ProjectIconOverride;
  className?: string | undefined;
}) {
  if (icon.kind === "monogram")
    return <ProjectMonogram text={icon.text} color={icon.color} className={className} />;
  if (icon.kind === "emoji")
    return (
      <ProjectFaviconFallback icon={FolderCodeIcon} emoji={icon.emoji} className={className} />
    );
  const colorClassName = projectIconColorClassName(icon.color);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        colorClassName,
        className,
      )}
    >
      <Suspense fallback={<DynamicProjectIconFallback />}>
        <LucideProjectIcon name={icon.name} className={cn("size-full", colorClassName)} />
      </Suspense>
    </span>
  );
}
export function ProjectFavicon(input: {
  readonly project: ProjectFaviconProject | null | undefined;
  readonly className?: string | undefined;
  readonly fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  if (input.project?.projectIcon)
    return <ProjectIconGraphic icon={input.project.projectIcon} className={input.className} />;
  return (
    <ProjectFaviconFallback
      icon={input.fallbackIcon ?? FolderCodeIcon}
      className={input.className}
      {...(!input.fallbackIcon && input.project ? { projectName: input.project.title } : {})}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
  emoji,
  projectName,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly emoji?: string | undefined;
  readonly projectName?: string | undefined;
}) {
  if (projectName && projectName.trim().length > 0) {
    const identity = deriveProjectIdentity(projectName);
    return (
      <ProjectMonogram text={identity.monogram} color={identity.color} className={className} />
    );
  }

  if (emoji) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{emoji}</span>
      </span>
    );
  }

  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}
