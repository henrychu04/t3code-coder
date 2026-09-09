import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ComposerPastedImage } from "../../lib/composerPastedImages";
import { getRestingComposerImagePreviewCounts } from "../composerFooterLayout";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { cn } from "../../lib/utils";

function ImagePreview({ file, className }: { file: File; className: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <img src={url} alt={file.name} className={className} draggable={false} decoding="async" />;
}

function uploadLabel(image: ComposerPastedImage): string | null {
  switch (image.status) {
    case "queued":
      return "Queued";
    case "uploading":
      return `${Math.floor(image.progress * 100)}%`;
    case "failed":
      return "Failed";
    case "uploaded":
      return null;
  }
}

/** Upstream-style thumbnails and gallery backed only by the original pasted bytes. */
export function ComposerPastedImages({
  images,
  compact = false,
  onRemove,
  onRetry,
}: {
  images: ReadonlyArray<ComposerPastedImage>;
  compact?: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = images.findIndex((image) => image.id === selectedId);
  const selectedImage = images[selectedIndex];
  const { visibleCount, overflowCount } = getRestingComposerImagePreviewCounts(images.length);
  const visible = compact ? images.slice(0, visibleCount) : images;
  const selectAdjacent = (offset: number) => {
    const image = images[selectedIndex + offset];
    if (image) setSelectedId(image.id);
  };
  if (images.length === 0) return null;
  return (
    <div aria-label="Pasted images" className={cn("px-3 sm:px-4", compact ? "py-1.5" : "py-3")}>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {visible.map((image) => (
          <div
            key={image.id}
            className={cn(
              "group/attachment relative shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background",
              compact ? "size-8" : "size-16",
            )}
          >
            <button
              type="button"
              className="size-full cursor-zoom-in"
              aria-label={`Preview ${image.file.name}`}
              onClick={() => setSelectedId(image.id)}
            >
              <ImagePreview file={image.file} className="size-full object-cover" />
            </button>
            {!compact && image.status !== "uploaded" ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-[10px] text-foreground">
                {uploadLabel(image)}
              </span>
            ) : null}
            {!compact && image.status === "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="absolute inset-x-0 bottom-0 h-5 bg-background/95 px-1 text-[10px]"
                aria-label={`Retry upload for ${image.file.name}`}
                title={image.error}
                onClick={() => onRetry(image.id)}
              >
                Retry
              </Button>
            ) : null}
            {!compact ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-0.5 top-0.5 bg-background/85 hover:bg-background/95"
                aria-label={`Remove ${image.file.name}`}
                onClick={() => onRemove(image.id)}
              >
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        ))}
        {compact && overflowCount > 0 ? (
          <button
            type="button"
            className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
            aria-label={`View all ${images.length} images`}
            onClick={() => setSelectedId(images[visibleCount]?.id ?? null)}
          >
            +{overflowCount}
          </button>
        ) : null}
        {compact && images.some((image) => image.status !== "uploaded") ? (
          <button
            type="button"
            className="text-xs text-muted-foreground"
            onClick={() =>
              setSelectedId(images.find((image) => image.status !== "uploaded")?.id ?? null)
            }
          >
            {images.some((image) => image.status === "failed") ? "Upload failed" : "Uploading…"}
          </button>
        ) : null}
      </div>
      <span role="status" className="sr-only">
        {images
          .filter((image) => image.status !== "uploaded")
          .map(
            (image) =>
              `${image.file.name}: ${image.status === "failed" ? image.error : image.status}`,
          )
          .join(". ")}
      </span>
      <Dialog
        open={selectedImage !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent
          className="max-h-[94vh] max-w-[94vw] overflow-hidden bg-background p-3"
          showCloseButton
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              selectAdjacent(-1);
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              selectAdjacent(1);
            }
          }}
        >
          <DialogTitle className="sr-only">
            {selectedImage?.file.name ?? "Pasted image"}
          </DialogTitle>
          {selectedImage ? (
            <>
              <ImagePreview
                file={selectedImage.file}
                className="max-h-[calc(88vh-4rem)] w-full object-contain"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedIndex <= 0}
                    aria-label="Previous image"
                    onClick={() => selectAdjacent(-1)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <span>
                    {selectedIndex + 1} / {images.length}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedIndex >= images.length - 1}
                    aria-label="Next image"
                    onClick={() => selectAdjacent(1)}
                  >
                    <ArrowRightIcon />
                  </Button>
                </div>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    selectedImage.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {selectedImage.status === "failed"
                    ? selectedImage.error
                    : uploadLabel(selectedImage)}
                </span>
                {selectedImage.status === "failed" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onRetry(selectedImage.id)}
                  >
                    Retry upload
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const next = images[selectedIndex + 1] ?? images[selectedIndex - 1];
                    setSelectedId(next?.id ?? null);
                    onRemove(selectedImage.id);
                  }}
                >
                  Remove image
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
