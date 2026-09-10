// Adapted from upstream 8d8189e67 ExpandedImageDialog: layout, navigation and zoom/pan.
// Coder supplies memory-only Blob URLs; external assets and media export are omitted.
import type { ScreenshotArtifactReference } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
    artifact?: ScreenshotArtifactReference | undefined;
    name: string;
    loading?: boolean;
    retry?: (() => void) | undefined;
  }[];
  index: number;
}
export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;
  const item = preview.images[index];
  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      setImageOffset(
        (current) => (current + direction + preview.images.length) % preview.images.length,
      );
    },
    [preview.images.length],
  );
  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isContextMenuOpen()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (zoomableImageRef.current?.pan(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  if (!item) return null;
  return createPortal(
    <div
      {...composerFloatingLayerProps}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
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
          <span className="truncate">
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
    </div>,
    document.body,
  );
});
