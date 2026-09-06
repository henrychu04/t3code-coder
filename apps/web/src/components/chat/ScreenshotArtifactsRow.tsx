import { type EnvironmentId, type ScreenshotArtifactReference } from "@t3tools/contracts";
import { memo, useState } from "react";
import { PaintbrushIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ScreenshotArtifactPreview } from "./ScreenshotArtifactPreview";
import { useScreenshotArtifacts } from "./useScreenshotArtifacts";
export const ScreenshotArtifactsRow = memo(function ScreenshotArtifactsRow(props: {
  artifacts: ReadonlyArray<ScreenshotArtifactReference>;
  environmentId: EnvironmentId;
}) {
  const { artifacts, environmentId } = props;
  const [expanded, setExpanded] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const images = useScreenshotArtifacts(environmentId, artifacts, expanded);

  const selectedArtifactIndex = artifacts.findIndex(
    (artifact) => artifact.id === selectedArtifactId,
  );
  const selectedArtifact = artifacts[selectedArtifactIndex];
  const selectedImage = selectedArtifact ? images[selectedArtifact.id] : undefined;
  const canSelectPrevious = selectedArtifactIndex > 0;
  const canSelectNext = selectedArtifactIndex >= 0 && selectedArtifactIndex < artifacts.length - 1;

  const selectAdjacentArtifact = (offset: -1 | 1) => {
    const artifact = artifacts[selectedArtifactIndex + offset];
    if (artifact) setSelectedArtifactId(artifact.id);
  };

  return (
    <div className="rounded-md px-0.5 py-0.5">
      <button
        type="button"
        className="flex min-h-6 w-full items-center gap-1.5 rounded-md text-left text-sm leading-relaxed text-secondary-label transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <PaintbrushIcon className="size-4 stroke-[1.8] opacity-70" />
        </span>
        <span className="min-w-0 flex-1 truncate">Visual artifacts · {artifacts.length}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "me-0.5 size-3 shrink-0 opacity-70 transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="ms-7 mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {artifacts.map((artifact) => {
            const image = images[artifact.id];
            return (
              <button
                key={artifact.id}
                type="button"
                className="min-w-0 overflow-hidden rounded-md border border-border/55 bg-muted/25 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-default"
                disabled={image?.status !== "loaded"}
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <ScreenshotArtifactPreview artifact={artifact} image={image} />
                <span className="block truncate border-t border-border/45 px-2 py-1 text-muted-foreground text-xs">
                  {artifact.name}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <Dialog
        open={selectedArtifact !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedArtifactId(null);
        }}
      >
        <DialogContent
          className="max-h-[94vh] max-w-[94vw] overflow-hidden bg-background p-3"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && canSelectPrevious) {
              event.preventDefault();
              selectAdjacentArtifact(-1);
            } else if (event.key === "ArrowRight" && canSelectNext) {
              event.preventDefault();
              selectAdjacentArtifact(1);
            }
          }}
          showCloseButton
        >
          <DialogTitle className="sr-only">{selectedArtifact?.name ?? "Screenshot"}</DialogTitle>
          <div className="flex min-h-0 flex-col gap-1">
            <div className="relative flex min-h-48 min-w-64 items-center justify-center overflow-hidden">
              {selectedImage?.status === "loaded" ? (
                <img
                  alt={selectedArtifact?.name ?? "Screenshot"}
                  className="max-h-[calc(88vh-2.25rem)] w-full object-contain"
                  draggable={false}
                  src={selectedImage.url}
                />
              ) : (
                <span className="text-muted-foreground text-sm">
                  {selectedImage?.status === "error" ? "Screenshot unavailable" : "Loading…"}
                </span>
              )}
              {artifacts.length > 1 ? (
                <>
                  <Button
                    aria-label="Previous screenshot"
                    className="absolute start-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 shadow-sm backdrop-blur-sm"
                    disabled={!canSelectPrevious}
                    onClick={() => selectAdjacentArtifact(-1)}
                    size="icon-sm"
                    variant="outline"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    aria-label="Next screenshot"
                    className="absolute end-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 shadow-sm backdrop-blur-sm"
                    disabled={!canSelectNext}
                    onClick={() => selectAdjacentArtifact(1)}
                    size="icon-sm"
                    variant="outline"
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              ) : null}
            </div>
            {artifacts.length > 1 ? (
              <div
                aria-live="polite"
                className="flex min-w-0 items-center justify-center gap-1.5 text-center text-muted-foreground text-xs"
              >
                <span className="min-w-0 truncate">{selectedArtifact?.name}</span>
                <span className="shrink-0">
                  · {selectedArtifactIndex + 1} of {artifacts.length}
                </span>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
