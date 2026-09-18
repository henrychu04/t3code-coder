// Main's file-based Markdown and gallery flow, adapted to helper stdio image reads.
import {
  createContext,
  useContext,
  useCallback,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ScreenshotArtifactDimensions,
} from "@t3tools/contracts";
import type { ProjectImageTarget } from "../../lib/readProjectImageBlob";
import { useProjectImages } from "./useProjectImages";
import { useImagePreviewVisibility } from "./useImagePreviewVisibility";
import { ChatMarkdownImage } from "./CapturedMarkdownImage";
import { ExpandedImageDialog, type ExpandedImagePreview } from "./ExpandedImageDialog";
import { authoredImageSizeStyle } from "./markdownImageLayout";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

export function isImageFilePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg|avif|bmp|ico|tiff?)$/i.test(path);
}
const InsideImageLink = createContext(false);
export function ProjectImageLink(props: {
  filePath: string | null;
  cwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  children: ReactNode;
  inline?: boolean;
  alt?: string | undefined;
  width?: string | number | undefined;
  height?: string | number | undefined;
  standalone?: boolean | undefined;
  maxHeightRem?: number | undefined;
  imageProps?: Omit<ComponentProps<"img">, "src" | "srcSet" | "alt" | "style"> | undefined;
  copyMarkdown?: string | undefined;
}) {
  const nested = useContext(InsideImageLink);
  if (nested && !props.inline) return <>{props.children}</>;
  if (!props.filePath || !props.cwd || !props.threadRef)
    return <span title="Image preview unavailable">{props.children}</span>;
  if (!/\.(?:png|jpe?g|webp)$/i.test(props.filePath))
    return (
      <span
        id={props.imageProps?.id}
        className="inline-flex max-w-full flex-wrap gap-1 text-xs text-muted-foreground"
        title="Supported image formats: PNG, JPEG, and WebP"
      >
        {props.children} · Unsupported image format. Use PNG, JPEG, or WebP.
      </span>
    );
  const target = {
    threadId: props.threadRef.threadId,
    cwd: props.cwd,
    filePath: props.filePath,
  };
  return (
    <InsideImageLink value={true}>
      <ProjectImageContent
        {...props}
        key={JSON.stringify([props.threadRef.environmentId, target])}
        environmentId={props.threadRef.environmentId}
        target={target}
      />
    </InsideImageLink>
  );
}

function ProjectImageContent(
  props: ComponentProps<typeof ProjectImageLink> & {
    environmentId: EnvironmentId;
    target: ProjectImageTarget;
  },
) {
  const { previewRef, visible } = useImagePreviewVisibility();
  const image = useProjectImages(
    props.environmentId,
    props.target,
    Boolean(props.inline && visible),
  );
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const [dimensions, setDimensions] = useState<ScreenshotArtifactDimensions>();
  const rememberDecodedDimensions = useCallback((image: HTMLImageElement) => {
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width > 0 && height > 0)
      setDimensions((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height },
      );
  }, []);
  const currentDimensions = image?.status === "loaded" ? image.dimensions : undefined;
  if (
    currentDimensions &&
    (dimensions?.width !== currentDimensions.width ||
      dimensions?.height !== currentDimensions.height)
  )
    setDimensions(currentDimensions);
  const style = authoredImageSizeStyle(props.width, props.height, props.maxHeightRem) ??
    authoredImageSizeStyle(
      currentDimensions?.width ?? dimensions?.width,
      currentDimensions?.height ?? dimensions?.height,
      props.maxHeightRem,
    ) ?? { width: "30rem", height: "auto", aspectRatio: "16 / 9", maxWidth: "100%" };

  const alt = props.alt ?? props.target.filePath.split("/").at(-1) ?? "Image";
  const item = {
    src: image?.status === "loaded" ? image.url : null,
    name: alt,
    projectImage: props.target,
  };
  const registerPreview = useCallback(
    (element: HTMLSpanElement | null) => {
      previewRef(element);
      if (element)
        markdownImageItems.set(element, {
          src: image?.status === "loaded" ? image.url : null,
          name: alt,
          projectImage: props.target,
        });
    },
    [previewRef, image, alt, props.target],
  );
  const retry = () => {
    if (image && "retry" in image) image.retry();
  };
  const { id, ...imageProps } = props.imageProps ?? {};
  const open = (element: Element) => setPreview(markdownImageGallery(element, item));
  return (
    <>
      {props.inline ? (
        <span
          id={id}
          ref={registerPreview}
          data-project-image
          data-image-preview
          tabIndex={-1}
          className="inline-block max-w-full"
        >
          {!visible || !image || image.status === "deferred" || image.status === "loading" ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Preview ${alt || "image"}`}
              className="inline-flex overflow-hidden aspect-video w-[30rem] max-w-full items-center justify-center rounded-lg border border-border/40 bg-muted/40 p-4 text-xs text-muted-foreground"
              data-markdown-copy={props.copyMarkdown}
              style={style}
              title={props.imageProps?.title ?? alt}
              onClick={(event) => {
                if (!event.currentTarget.closest("a")) {
                  event.preventDefault();
                  event.stopPropagation();
                  open(event.currentTarget);
                }
              }}
              onKeyDown={(event) => {
                if (
                  (event.key === "Enter" || event.key === " ") &&
                  !event.currentTarget.closest("a")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  open(event.currentTarget);
                }
              }}
            >
              <span className="min-w-0 truncate">
                {visible && (!image || image.status === "loading") ? "Loading image" : "Open image"}
                {alt ? ` · ${alt}` : ""}
              </span>
            </span>
          ) : (
            <ChatMarkdownImage
              src={item.src}
              onDecoded={currentDimensions ? undefined : rememberDecodedDimensions}
              sourceFailed={image?.status === "error"}
              alt={alt}
              copyMarkdown={props.copyMarkdown}
              standalone={props.standalone ?? true}
              imageProps={imageProps}
              className={props.imageProps?.className}
              style={style}
              retry={retry}
              projectImage={props.target}
              onImageExpand={setPreview}
            />
          )}
        </span>
      ) : (
        <a
          href="#"
          title="Preview image"
          className="cursor-pointer text-primary underline"
          ref={(element) => {
            if (element) markdownImageItems.set(element, item);
          }}
          onClick={(event) => {
            event.preventDefault();
            open(event.currentTarget.querySelector("img") ?? event.currentTarget);
          }}
        >
          {props.children}
        </a>
      )}
      {preview ? (
        <ProjectImageDialog
          environmentId={props.environmentId}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}

export function ProjectImageDialog({
  environmentId,
  preview,
  onClose,
}: {
  environmentId: EnvironmentId;
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(preview.index);
  const image = useProjectImages(environmentId, preview.images[index]?.projectImage, true, true);
  return (
    <ExpandedImageDialog
      onClose={onClose}
      onIndexChange={setIndex}
      preview={{
        index,
        images: preview.images.map((item, i) => ({
          ...item,
          src: i === index && image?.status === "loaded" ? image.url : null,
          loading:
            i === index && (!image || image.status === "loading" || image.status === "deferred"),
          retry: image && "retry" in image ? image.retry : undefined,
        })),
      }}
    />
  );
}
