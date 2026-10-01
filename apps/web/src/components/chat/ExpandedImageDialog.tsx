// Upstream's ExpandedImageDialog. Coder reads workspace media through helper stdio chunks instead
// of signed asset URLs: the selected image is read with priority, a video loads when the dialog
// opens, and adapters may report `loading` and `retry`. SnapShot accessibility details are omitted.
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  wrapExpandedImageIndex,
  type ExpandedImageItem,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useProjectImages } from "./useProjectImages";
import { useProjectVideo } from "./useProjectVideo";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  /** Coder: adapters that resolve items by identity own the selected index. */
  onIndexChange?: ((index: number) => void) | undefined;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedVideo({
  item,
  onLoaded,
}: {
  readonly item: ExpandedImageItem;
  readonly onLoaded: (src: string | null) => void;
}) {
  const { state, retry } = useProjectVideo(item.projectVideo, item.projectVideo !== undefined);
  const src = item.projectVideo
    ? state.status === "loaded"
      ? state.src + (item.srcFragment ?? "")
      : null
    : item.src;
  useEffect(() => onLoaded(src), [onLoaded, src]);
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={state.status === "failed"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={item.projectVideo ? retry : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  onIndexChange,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocus] = useState(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { target, preview: target?.closest<HTMLElement>("[data-image-preview]") };
  });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The offset accumulates without bound, so wrap it into range in both directions.
  const imageCount = preview.images.length;
  const index = wrapExpandedImageIndex(
    preview.index + (onIndexChange ? 0 : imageOffset),
    imageCount,
  );
  const listedItem = preview.images[index];
  const projectImage = useProjectImages(
    listedItem?.projectImage?.environmentId,
    listedItem?.projectImage?.target,
    listedItem?.type !== "video" && listedItem?.projectImage !== undefined,
    true,
  );
  const item: ExpandedImageItem | undefined =
    listedItem?.projectImage && listedItem.type !== "video"
      ? {
          ...listedItem,
          src:
            projectImage?.status === "loaded"
              ? projectImage.url + (listedItem.srcFragment ?? "")
              : null,
          loading:
            !projectImage ||
            projectImage.status === "loading" ||
            projectImage.status === "deferred",
          retry: projectImage && "retry" in projectImage ? projectImage.retry : undefined,
        }
      : listedItem;
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  // Coder's byte actions read the source the dialog shows, such as a helper-read blob.
  const shownSource: MediaActionSource = {
    ...source,
    src: item?.type === "video" ? videoSrc : (item?.src ?? null),
  };
  const actionsSource: MediaActionSource = openFile
    ? {
        ...shownSource,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : shownSource;

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      if (onIndexChange) {
        onIndexChange(wrapExpandedImageIndex(index + direction, imageCount));
        return;
      }
      setImageOffset((current) => current + direction);
    },
    [imageCount, index, onIndexChange],
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen() || event.target instanceof HTMLVideoElement)
      return;
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
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (details.reason === "escape-key" && isContextMenuOpen()) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => {
          if (returnFocus.target?.isConnected) return returnFocus.target;
          // Coder: eviction can replace an image with a placeholder while the gallery is open.
          const preview = returnFocus.preview;
          return preview?.isConnected ? preview : null;
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <MediaActions source={actionsSource}>
          <div className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]">
            <Button
              type="button"
              ref={closeButtonRef}
              size="icon-xs"
              variant="media-close"
              className="absolute right-0 -top-10 z-20"
              onClick={onClose}
              aria-label={`Close ${mediaLabel} preview`}
            >
              <XIcon />
            </Button>
            {item.type === "video" ? (
              <ExpandedVideo key={index} item={item} onLoaded={setVideoSrc} />
            ) : item.loading ? (
              <div role="status" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
                Loading image…
              </div>
            ) : item.src === null || failedImageSrc === item.src ? (
              <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
                <p>
                  {openOriginalLink
                    ? "This image could not be loaded."
                    : "Image unavailable. The file may have been moved or deleted."}
                </p>
                {openOriginalLink}
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
            <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80">
              <span className="truncate" aria-live="polite" aria-atomic="true">
                {item.name}
                {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
              </span>
            </div>
          </div>
        </MediaActions>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next media"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
});
