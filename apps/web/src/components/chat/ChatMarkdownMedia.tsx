import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import type { MediaSourceResource } from "@t3tools/client-runtime/media-source";
import type { ToolOutputImageResource } from "@t3tools/client-runtime/work-log/item-detail";
import type { EnvironmentId } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import {
  createContext,
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useAssetImageSize, useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import type { ImageAssetResource } from "../../state/assets";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProjectMarkdownVideo } from "./ProjectVideo";
import { useImagePreviewVisibility } from "./useImagePreviewVisibility";
import type { ProjectMediaSource } from "./useProjectVideo";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
export const MarkdownLinkContext = createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
  /** Coder: helper reads can be retried in place. */
  readonly retry?: (() => void) | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {props.alt.length > 0 ? `${label} · ${props.alt}` : label}
      {props.retry ? (
        <button type="button" className="underline" onClick={props.retry}>
          Retry image
        </button>
      ) : null}
    </span>
  );
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
  readonly actionsSource?: MediaActionSource | undefined;
  readonly retry?: (() => void) | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} retry={props.retry} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 *
 * Coder: extended with a helper `retry`, an `onDecoded` size report, and the
 * helper source a gallery rereads.
 */
export function ChatMarkdownImage(props: {
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly retry?: (() => void) | undefined;
  readonly onDecoded?: ((image: HTMLImageElement) => void) | undefined;
  readonly helperSource?: Pick<ExpandedImageItem, "projectImage"> | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  const onDecoded = props.onDecoded;
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) {
      setLoadedSrc(image.currentSrc || image.src);
      onDecoded?.(image);
    }
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
      ...props.helperSource,
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: (event: { currentTarget: HTMLImageElement }) => {
      onDecoded?.(event.currentTarget);
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        retry={props.retry}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} retry={props.retry} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

export function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

/** Coder: the image formats the helper validates by signature and a browser can render. */
export function isImageFilePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(path);
}

/**
 * Coder: there is no signed asset URL. Images read through the helper's bounded stdio chunks into
 * the shared image store. A workspace file reads near the viewport only, from the thread root the
 * helper verifies, and keeps its gallery entry while its bytes are released; videos show a play
 * card that reads the file when pressed, because a whole-file read is not a cheap metadata preload.
 */
export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  // Coder: the helper reads workspace files and tool output images.
  readonly resource: MediaSourceResource | ToolOutputImageResource;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly framed?: boolean | undefined;
  /** Coder: the thread root the helper verifies before reading a workspace file. */
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const resource = props.resource;
  // Coder: the helper reads a workspace file by thread and root, in a format it validates.
  const projectImage: ProjectMediaSource | undefined =
    resource._tag === "media-file" && props.workspaceRoot
      ? {
          environmentId: props.environmentId,
          target: {
            threadId: resource.threadId,
            cwd: props.workspaceRoot,
            filePath: resource.path,
          },
        }
      : undefined;
  const imageResource: ImageAssetResource | null =
    props.kind === "video"
      ? null
      : resource._tag === "tool-output-image"
        ? resource
        : projectImage && isImageFilePath(resource.path)
          ? { _tag: "project-image", target: projectImage.target }
          : null;
  const { previewRef, visible } = useImagePreviewVisibility();
  const assetUrl = useAssetUrlState(
    props.environmentId,
    projectImage && !visible ? null : imageResource,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, imageResource);
  // Coder: the workspace's helper connection stands in for upstream's prepared HTTP connection.
  const connectionReady = useConnectedEnvironmentIds().includes(props.environmentId);
  const refreshToken = JSON.stringify([props.environmentId, resource, props.workspaceMutationId]);
  const handledRefreshToken = useRef<string | null | undefined>(undefined);
  const assetLoading = assetUrl._tag === "Loading";
  useEffect(() => {
    if (!connectionReady) {
      handledRefreshToken.current = null;
      return;
    }
    if (
      props.workspaceMutationId === undefined ||
      props.kind === "video" ||
      resource._tag !== "media-file" ||
      handledRefreshToken.current === refreshToken
    ) {
      return;
    }
    if (assetLoading) {
      // Only the initial mount shares a pending request; edits and reconnects need a new one.
      if (handledRefreshToken.current === undefined) {
        handledRefreshToken.current = refreshToken;
      }
      return;
    }
    handledRefreshToken.current = refreshToken;
    void refreshAssetUrl().catch(() => undefined);
  }, [
    assetLoading,
    connectionReady,
    props.kind,
    props.workspaceMutationId,
    refreshAssetUrl,
    refreshToken,
    resource._tag,
  ]);
  // Coder: the image's header or decoded size keeps its box while its bytes are released.
  const [imageSize, rememberImageSize] = useAssetImageSize(props.environmentId, imageResource);
  const rememberDecodedSize = (image: HTMLImageElement) => {
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0) return;
    if (imageSize?.width === width && imageSize.height === height) return;
    rememberImageSize({ width, height });
  };
  const kind = props.kind ?? "image";
  if (resource._tag === "media-file") {
    // Coder: the helper reads only these signature-checked formats, so others are named, not read.
    if (kind === "image" && !isImageFilePath(resource.path)) {
      return (
        <span
          id={props.imageProps?.id}
          data-markdown-copy={props.copyMarkdown}
          className="inline-flex max-w-full flex-wrap gap-1 text-xs text-muted-foreground"
          title="Supported image formats: PNG, JPEG, WebP, GIF, AVIF, SVG, BMP, and ICO"
        >
          {props.alt || resource.path.split("/").at(-1)} · Unsupported image format.
        </span>
      );
    }
    if (!projectImage) {
      return (
        <ChatMarkdownImageFallback alt={props.alt} copyMarkdown={props.copyMarkdown} kind={kind} />
      );
    }
    if (kind === "video") {
      return (
        <ProjectMarkdownVideo
          source={projectImage}
          alt={props.alt}
          copyMarkdown={props.copyMarkdown}
          style={props.style}
          className={cn(
            CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
            CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
            "w-full",
          )}
          videoClassName={cn(
            CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
            CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
          )}
        />
      );
    }
  }
  const path = resource._tag === "media-file" ? resource.path : undefined;
  const reference = path ? mediaFileReference(path, props.workspaceRoot) : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const src = assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null;
  // Coder: one size for loaded and released states, so swapping them never resizes the row.
  const knownSize =
    imageSize ?? (assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined);
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind,
    name: props.alt || kind,
    src,
    ...(reference ? { reference } : {}),
    ...(relativePath && resource._tag === "media-file"
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                relativePath,
              ),
        }
      : {}),
  };
  // Coder: a workspace image's wrapper carries its authored `id`.
  const { id, ...wrappedImageProps } = props.imageProps ?? {};

  const image = (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure"}
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={projectImage ? wrappedImageProps : props.imageProps}
      actionsSource={actionsSource}
      onImageExpand={props.onImageExpand}
      // Coder: helper reads retry in place.
      retry={() => void refreshAssetUrl().catch(() => undefined)}
      onDecoded={rememberDecodedSize}
      helperSource={projectImage ? { projectImage } : undefined}
    />
  );
  if (!projectImage) return image;

  // Coder: the wrapper keeps a workspace image's gallery entry while offscreen bytes are released,
  // and a deferred or loading image can still open the gallery, which reads it with priority.
  const expand = props.onImageExpand;
  const name = props.alt.trim() || "image";
  const item: ExpandedImageItem = {
    src,
    name,
    actionsSource,
    projectImage,
    ...(props.srcFragment ? { srcFragment: props.srcFragment } : {}),
  };
  const registerPreview = (element: HTMLSpanElement | null) => {
    previewRef(element);
    if (element) markdownImageItems.set(element, item);
  };
  const pending = !visible || assetUrl._tag === "Loading";
  // A flex wrapper is exactly its child's height, so swapping the image for a placeholder of the
  // same size never adds a text-baseline gap that would resize the row.
  return (
    <span
      id={id}
      ref={registerPreview}
      data-project-image
      data-image-preview
      tabIndex={-1}
      className="inline-flex max-w-full align-middle"
    >
      {pending ? (
        <span
          data-markdown-copy={props.copyMarkdown}
          className={cn(
            CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
            props.standalone === false
              ? "rounded-md border border-border/40 bg-muted/40 px-2 py-1"
              : CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
            "items-center justify-center p-2 text-center text-xs text-muted-foreground",
            expand && "cursor-zoom-in",
          )}
          style={style}
          title={wrappedImageProps.title ?? props.alt}
          {...(expand
            ? {
                role: "button" as const,
                tabIndex: 0,
                "aria-label": `Preview ${name}`,
                onClick: (event: ReactMouseEvent<HTMLSpanElement>) => {
                  if (event.currentTarget.closest("a")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  expand(markdownImageGallery(event.currentTarget, item));
                },
                onKeyDown: (event: ReactKeyboardEvent<HTMLSpanElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  if (event.currentTarget.closest("a")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  expand(markdownImageGallery(event.currentTarget, item));
                },
              }
            : { role: "status" as const })}
        >
          {visible && assetUrl._tag === "Loading" && !assetUrl.deferred
            ? "Loading image"
            : "Open image"}
          {props.alt ? ` · ${props.alt}` : ""}
        </span>
      ) : (
        image
      )}
    </span>
  );
});
