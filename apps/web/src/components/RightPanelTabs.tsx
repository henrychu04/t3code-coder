import { Bot, FileDiff, Plus, TerminalSquare, X } from "lucide-react";
import type { ReactNode } from "react";

import type { RightPanelSurface } from "../rightPanelStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface RightPanelTabsProps {
  readonly mode: "inline" | "sheet";
  readonly maximized?: boolean;
  readonly layoutControls?: ReactNode;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  readonly onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  readonly onCloseAllSurfaces: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddAgents: () => void;
  readonly terminalAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly agentsAvailable: boolean;
  readonly liveAgentCount: number;
  readonly children: ReactNode;
}

function surfaceLabel(
  surface: RightPanelSurface,
  terminalLabels: ReadonlyMap<string, string>,
): string {
  if (surface.kind === "diff") return "Diff";
  if (surface.kind === "agents") return "Agents";
  return terminalLabels.get(surface.activeTerminalId) ?? "Terminal";
}

function SurfaceIcon({ surface }: { readonly surface: RightPanelSurface }) {
  if (surface.kind === "diff") return <FileDiff className="size-3.5" />;
  if (surface.kind === "agents") return <Bot className="size-3.5" />;
  return <TerminalSquare className="size-3.5" />;
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const noSurfaces = props.surfaces.length === 0;

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col border-l border-border bg-background",
        props.mode === "inline" && (props.maximized ? "w-full" : "w-[min(48vw,52rem)]"),
        props.mode === "sheet" && "w-full",
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.surfaces.map((surface) => (
            <div
              key={surface.id}
              className={cn(
                "flex shrink-0 items-center rounded-md",
                surface.id === props.activeSurfaceId ? "bg-accent" : "hover:bg-muted",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs"
                onClick={() => props.onActivate(surface)}
                onDoubleClick={() => props.onCloseOtherSurfaces(surface)}
                title="Double-click to close other tabs"
              >
                <SurfaceIcon surface={surface} />
                <span className="max-w-32 truncate">
                  {surfaceLabel(surface, props.terminalLabelsById)}
                </span>
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label={`Close ${surfaceLabel(surface, props.terminalLabelsById)}`}
                onClick={() => props.onCloseSurface(surface)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onCloseSurfacesToRight(surface);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close all panel tabs"
          onClick={props.onCloseAllSurfaces}
          disabled={noSurfaces}
        >
          <X className="size-3.5" />
        </Button>
        {props.layoutControls}
      </header>

      {noSurfaces ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">Open a workspace surface</h2>
            <div className="mt-4 grid gap-2">
              <Button
                variant="outline"
                className="justify-start"
                disabled={!props.terminalAvailable}
                onClick={props.onAddTerminal}
              >
                <TerminalSquare className="size-4" /> Terminal
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                disabled={!props.diffAvailable}
                onClick={props.onAddDiff}
              >
                <FileDiff className="size-4" /> Diff
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                disabled={!props.agentsAvailable}
                onClick={props.onAddAgents}
              >
                <Bot className="size-4" /> Agents
                {props.liveAgentCount > 0 ? ` (${props.liveAgentCount})` : ""}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">{props.children}</div>
      )}
    </section>
  );
}
