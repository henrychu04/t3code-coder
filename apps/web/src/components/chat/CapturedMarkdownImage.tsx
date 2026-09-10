// Adapted from upstream 8d8189e67 ChatMarkdownImage. Only captured Blob URLs are rendered.
import {
  useCallback,
  useState,
  type CSSProperties,
  type ComponentProps,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import type { EnvironmentId, ScreenshotArtifactReference } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useScreenshotArtifacts } from "./useScreenshotArtifacts";
import { ExpandedImageDialog, type ExpandedImagePreview } from "./ExpandedImageDialog";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";
import { authoredImageSizeStyle } from "./markdownImageLayout";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME =
  "h-auto w-auto object-contain max-h-[30rem] max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME =
  "aspect-video w-full overflow-hidden bg-muted/60 max-w-[min(100%,30rem)] rounded-lg border border-border/40";
function ChatMarkdownMediaUnavailableLabel({ alt, retry }: { alt: string; retry: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      Image unavailable{alt ? ` · ${alt}` : ""}{" "}
      <button type="button" className="underline" onClick={retry}>
        Retry image
      </button>
    </span>
  );
}
function ChatMarkdownImageFallback({
  alt,
  retry,
  copyMarkdown,
}: {
  alt: string;
  retry: () => void;
  copyMarkdown?: string | undefined;
}) {
  return (
    <span
      data-markdown-copy={copyMarkdown}
      className="inline-block! rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      role="alert"
    >
      <ChatMarkdownMediaUnavailableLabel alt={alt} retry={retry} />
    </span>
  );
}
function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const expand = (event: MouseEvent | KeyboardEvent) => {
    if (event.currentTarget.closest("a, button")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${alt.trim() || "image"}`,
    onClick: expand,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}
function ChatMarkdownImage(props: {
  /** Null while the URL is being resolved; the last decoded image stays up. */
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly retry: () => void;
  readonly artifact: ScreenshotArtifactReference;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  // A failure forgets the decoded image so the next URL loads behind the slot.
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
      markdownImageItems.set(image, {
        src,
        name: props.alt.trim() || "image",
        retry: props.retry,
        artifact: props.artifact,
      });
    },
    [props.retry, props.alt, props.artifact, src],
  );
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
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
      <>
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
      </>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
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
    <>
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
    </>
  );
}

export function CapturedMarkdownImage({
  environmentId,
  artifact,
  alt,
  width,
  height,
  standalone = true,
  imageProps,
  copyMarkdown,
}: {
  environmentId: EnvironmentId;
  artifact: ScreenshotArtifactReference;
  alt: string;
  width?: string | number | undefined;
  height?: string | number | undefined;
  standalone?: boolean | undefined;
  imageProps?: Omit<ComponentProps<"img">, "src" | "srcSet" | "alt" | "style"> | undefined;
  copyMarkdown?: string | undefined;
}) {
  const images = useScreenshotArtifacts(environmentId, [artifact], true);
  const image = images[artifact.id];
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const style = authoredImageSizeStyle(width, height);
  const retry = () => {
    if (image && image.status !== "loading") image.retry();
  };
  return (
    <>
      <ChatMarkdownImage
        src={image?.status === "loaded" ? image.url : null}
        sourceFailed={image?.status === "error"}
        alt={alt}
        copyMarkdown={copyMarkdown}
        imageProps={imageProps}
        className={imageProps?.className}
        standalone={standalone}
        style={style}
        retry={retry}
        artifact={artifact}
        onImageExpand={setPreview}
      />
      {preview ? (
        <CapturedImageDialog
          environmentId={environmentId}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}

// Coder transport adapter: the upstream presentation receives current URLs even after retry.
export function CapturedImageDialog({
  environmentId,
  preview,
  onClose,
}: {
  environmentId: EnvironmentId;
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const artifacts = preview.images.flatMap((item) => (item.artifact ? [item.artifact] : []));
  const resources = useScreenshotArtifacts(environmentId, artifacts, true);
  return (
    <ExpandedImageDialog
      onClose={onClose}
      preview={{
        ...preview,
        images: preview.images.map((item) => {
          const resource = item.artifact ? resources[item.artifact.id] : undefined;
          return resource
            ? {
                ...item,
                src: resource.status === "loaded" ? resource.url : null,
                loading: resource.status === "loading",
                retry: resource.status === "loading" ? undefined : resource.retry,
              }
            : item;
        }),
      }}
    />
  );
}
