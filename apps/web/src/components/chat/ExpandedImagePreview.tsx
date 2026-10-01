// Upstream's expanded-media item and resolvers. Coder has no signed asset URLs: workspace media
// carries a helper source that the dialog reads through bounded `projects.readImage` chunks, and
// legacy screenshot artifacts are resolved by `CapturedImageDialog`.
import type { ScopedThreadRef, ScreenshotArtifactReference } from "@t3tools/contracts";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import type { ProjectMediaSource } from "./useProjectVideo";
import type { MediaActionSource } from "../media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export interface ExpandedImageItem {
  /** A loadable URL, or null when the dialog must read it through the helper first. */
  src: string | null;
  name: string;
  type?: "video";
  autoPlay?: boolean;
  /** Authored remote destination to open when embedding fails, never a generated blob URL. */
  originalUrl?: string;
  srcFragment?: string;
  actionsSource?: MediaActionSource;
  /** Coder: a workspace image read through the helper, with priority, while it is selected. */
  projectImage?: ProjectMediaSource | undefined;
  /** Coder: a workspace video or audio file read through the helper when the dialog opens. */
  projectVideo?: ProjectMediaSource | undefined;
  /** Coder: a legacy screenshot artifact resolved by `CapturedImageDialog`. */
  artifact?: (Omit<ScreenshotArtifactReference, "sizeBytes"> & { sizeBytes?: number }) | undefined;
  /** Coder: set by transport adapters while a helper read is in flight. */
  loading?: boolean | undefined;
  retry?: (() => void) | undefined;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

/** Wraps navigation in either direction, including offsets beyond a complete cycle. */
export function wrapExpandedImageIndex(index: number, imageCount: number): number {
  return imageCount > 0 ? ((index % imageCount) + imageCount) % imageCount : 0;
}

/** Resolves a chat media reference on its owning workspace, without reading its bytes. */
export async function resolveMarkdownMediaPreview(input: {
  source: string;
  resolvedFilePath?: string | undefined;
  cwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  onOpenFile?: ((relativePath: string) => void) | undefined;
}): Promise<ExpandedImagePreview | null> {
  const media = resolveMediaSource(input.source, {
    threadId: input.threadRef?.threadId,
    workspaceRoot: input.cwd,
    resolvedFilePath: input.resolvedFilePath,
  });
  if (media === null) return null;
  const { kind, name, reference } = media;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;

  let src: string | null = null;
  let helperSource: ProjectMediaSource | undefined;
  if (media.access === "direct") {
    src = resolveProtocolRelativeMediaUrl(media.uri);
  } else {
    // The helper verifies that this root belongs to the thread before reading the file.
    if (media.access === "unavailable" || !input.threadRef || !input.cwd) {
      throw new Error("Reconnect to this environment and open the media again.");
    }
    helperSource = {
      environmentId: input.threadRef.environmentId,
      target: { threadId: media.resource.threadId, cwd: input.cwd, filePath: media.resource.path },
    };
  }
  return {
    images: [
      {
        src,
        name,
        ...(kind === "video" ? { type: "video", autoPlay: false } : {}),
        ...(helperSource
          ? kind === "video"
            ? { projectVideo: helperSource }
            : { projectImage: helperSource }
          : {}),
        ...(media.access === "direct" && resolveExternalWebLinkHost(media.uri) !== null
          ? { originalUrl: media.uri }
          : {}),
        ...(media.srcFragment ? { srcFragment: media.srcFragment } : {}),
        actionsSource: {
          kind,
          name,
          src,
          ...(reference ? { reference } : {}),
          ...(relativePath && input.onOpenFile
            ? { onOpenFile: () => input.onOpenFile?.(relativePath) }
            : {}),
        },
      },
    ],
    index: 0,
  };
}

export function expandedImageKey(preview: ExpandedImagePreview): string {
  const item = preview.images[preview.index];
  const helperSource = item?.projectImage ?? item?.projectVideo;
  const identity =
    item?.src ??
    (helperSource
      ? JSON.stringify([helperSource.environmentId, helperSource.target])
      : (item?.artifact?.id ?? "image"));
  return `${identity}:${preview.index}`;
}

/** Upstream's preview builder for composer images already in memory; Coder has no video drafts. */
export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly previewUrl?: string | undefined;
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.type === "image" && image.previewUrl
      ? [{ id: image.id, src: image.previewUrl, name: image.name }]
      : [],
  );
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) return null;
  return {
    images: previewableImages.map((image) => ({ src: image.src, name: image.name })),
    index: selectedIndex,
  };
}
