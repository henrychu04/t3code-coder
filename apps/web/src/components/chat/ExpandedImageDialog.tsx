// Adapted from upstream 3be02ae57 ExpandedImageDialog: layout, navigation and zoom/pan.
// Coder supplies memory-only Blob URLs; external assets and media export are omitted.
import type { ProjectImageTarget } from "../../lib/readProjectImageBlob";
import type { ScreenshotArtifactReference } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

// Same state dimensions as upstream, with retry supplied by the Coder transport.
const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(92vw,32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

export interface ExpandedImagePreview {
  images: {
    src: string | null;
    projectImage?: ProjectImageTarget | undefined;
    artifact?:
      | (Omit<ScreenshotArtifactReference, "sizeBytes"> & { sizeBytes?: number })
      | undefined;
    name: string;
    loading?: boolean;
    retry?: (() => void) | undefined;
  }[];
  index: number;
}
export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  onIndexChange,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const index =
    (preview.index + (onIndexChange ? 0 : imageOffset) + preview.images.length) %
    preview.images.length;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [returnFocus] = useState(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { target, preview: target?.closest<HTMLElement>("[data-image-preview]") };
  });
  const item = preview.images[index];
  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      if (onIndexChange) {
        onIndexChange((index + direction + preview.images.length) % preview.images.length);
        return;
      }
      setImageOffset(
        (current) => (current + direction + preview.images.length) % preview.images.length,
      );
    },
    [index, onIndexChange, preview.images.length],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen()) return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight"))
      return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(event.key === "ArrowLeft" ? -1 : 1);
  };
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  if (!item) return null;
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          if (details.reason === "escape-key" && isContextMenuOpen()) {
            details.cancel();
            return;
          }
          onClose();
        }
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        backdropClassName="z-[60]"
        viewportClassName="z-[60] grid-rows-1 place-items-center px-4 py-6"
        className="row-start-1 flex max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => {
          if (returnFocus.target?.isConnected) return returnFocus.target;
          // Eviction can replace an image with a placeholder while the gallery is open.
          const preview = returnFocus.preview;
          return preview?.isConnected ? preview : null;
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded image preview</DialogTitle>
        <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            ref={closeButtonRef}
            onClick={onClose}
            className="absolute right-2 top-2 z-20"
            aria-label="Close image preview"
          >
            <XIcon />
          </Button>
          {item.loading ? (
            <div role="status" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
              Loading image…
            </div>
          ) : item.src === null || failedImageSrc === item.src ? (
            <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
              <p>Image unavailable.</p>
              {item.retry ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setFailedImageSrc(null);
                    item.retry?.();
                  }}
                >
                  Retry image
                </Button>
              ) : null}
            </div>
          ) : (
            <ZoomableImage
              ref={zoomableImageRef}
              key={`${index}:${item.src}`}
              src={item.src}
              name={item.name}
              onError={() => setFailedImageSrc(item.src)}
            />
          )}
          <div className="mt-2 flex max-w-[92vw] items-center justify-center gap-1.5 text-xs text-white/80">
            <span className="truncate" aria-live="polite" aria-atomic="true">
              {item.name}
              {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
            </span>
          </div>
        </div>
        {preview.images.length > 1 ? (
          <>
            <Button
              type="button"
              size="icon-xl"
              variant="overlay"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 sm:left-6"
              aria-label="Previous image"
              onClick={() => navigateImage(-1)}
            >
              <ChevronLeftIcon className="size-7" />
            </Button>
            <Button
              type="button"
              size="icon-xl"
              variant="overlay"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 sm:right-6"
              aria-label="Next image"
              onClick={() => navigateImage(1)}
            >
              <ChevronRightIcon className="size-7" />
            </Button>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
});
