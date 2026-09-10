import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ComposerPastedImage } from "../../lib/composerPastedImages";
import { getRestingComposerImagePreviewCounts } from "../composerFooterLayout";
import { Button } from "../ui/button";
import { ExpandedImageDialog, type ExpandedImagePreview } from "./ExpandedImageDialog";
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
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = images.findIndex((image) => image.id === selectedId);
  const selectedImage = images[selectedIndex];
  const { visibleCount, overflowCount } = getRestingComposerImagePreviewCounts(images.length);
  const visible = compact ? images.slice(0, visibleCount) : images;
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
            {!compact && image.status === "failed" && onRetry ? (
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
            {!compact && onRemove ? (
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
      {selectedImage ? (
        <PastedImageGallery
          images={images}
          index={selectedIndex}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function PastedImageGallery({
  images,
  index,
  onClose,
}: {
  images: ReadonlyArray<ComposerPastedImage>;
  index: number;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  useEffect(() => {
    const items = images.map((image) => ({
      name: image.file.name,
      src: URL.createObjectURL(image.file),
    }));
    setPreview({ images: items, index });
    return () => {
      for (const item of items) URL.revokeObjectURL(item.src);
    };
  }, [images, index]);
  return preview ? <ExpandedImageDialog preview={preview} onClose={onClose} /> : null;
}
