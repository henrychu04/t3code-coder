// Upstream's markdownImageGallery. Coder also collects `[data-project-image]` wrappers: helper-read
// previews release offscreen bytes, so navigation must not depend on which images have loaded.
import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

/** Coder: helper images match by workspace file, since a URL exists only once bytes are read. */
function isSameMedia(left: ExpandedImageItem, right: ExpandedImageItem): boolean {
  if (left.projectImage && right.projectImage)
    return (
      left.projectImage.environmentId === right.projectImage.environmentId &&
      JSON.stringify(left.projectImage.target) === JSON.stringify(right.projectImage.target)
    );
  return left.src !== null && left.src === right.src;
}

// Weak keys retain resolved media actions only while the rendered image is reachable.
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

/** Collect in document order only when opened, including PR sections separated by videos. */
export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("[data-project-image], img") ?? []) {
    if (image.tagName === "IMG" && image.closest("[data-project-image]")) continue;
    const registered = markdownImageItems.get(image);
    if (!registered) continue;
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && mediaKindFromPath(href) !== "image") continue;
    const linkedSource =
      resolveExternalWebLinkHost(href) !== null ? resolveProtocolRelativeMediaUrl(href) : null;
    const reference = mediaUrlReference(href);
    const item: ExpandedImageItem = linkedSource
      ? {
          src: linkedSource,
          name: registered.name,
          originalUrl: href,
          actionsSource: {
            kind: "image" as const,
            name: registered.name,
            src: linkedSource,
            ...(reference ? { reference } : {}),
          },
        }
      : registered;
    if (
      image === element ||
      image.contains(element) ||
      (!markdownImageItems.has(element) && index < 0 && isSameMedia(item, selected))
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}
