import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BotIcon,
  BookOpenIcon,
  BracesIcon,
  CircuitBoardIcon,
  CloudCogIcon,
  Code2Icon,
  DatabaseIcon,
  FlaskConicalIcon,
  FolderCodeIcon,
  Gamepad2Icon,
  Globe2Icon,
  ImageIcon,
  Layers3Icon,
  MonitorIcon,
  MusicIcon,
  PackageIcon,
  ServerIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  SmartphoneIcon,
  TerminalIcon,
  VideoIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { selectProjectIcon, type ProjectIconName } from "../projectIconModel";
import { cn } from "~/lib/utils";

const PROJECT_ICONS: Record<ProjectIconName, ComponentType<{ className?: string }>> = {
  ai: BotIcon,
  book: BookOpenIcon,
  braces: BracesIcon,
  circuit: CircuitBoardIcon,
  cloud: CloudCogIcon,
  code: Code2Icon,
  database: DatabaseIcon,
  desktop: MonitorIcon,
  "folder-code": FolderCodeIcon,
  game: Gamepad2Icon,
  image: ImageIcon,
  layers: Layers3Icon,
  mobile: SmartphoneIcon,
  music: MusicIcon,
  package: PackageIcon,
  security: ShieldCheckIcon,
  server: ServerIcon,
  shopping: ShoppingBagIcon,
  terminal: TerminalIcon,
  test: FlaskConicalIcon,
  video: VideoIcon,
  web: Globe2Icon,
};

/**
 * Automatic upstream icons use project metadata already in memory.
 * Never fetch a favicon or resolve a workspace image path in the browser.
 */
export type ProjectFaviconProject = Pick<EnvironmentProject, "title" | "workspaceRoot">;

export function ProjectFavicon(input: {
  readonly project: ProjectFaviconProject | null | undefined;
  readonly className?: string;
  readonly fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const selection = selectProjectIcon(
    input.project?.title ?? "",
    input.project?.workspaceRoot ?? "",
  );
  const Icon = input.fallbackIcon ?? PROJECT_ICONS[selection.icon];
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", input.className)} />;
}
