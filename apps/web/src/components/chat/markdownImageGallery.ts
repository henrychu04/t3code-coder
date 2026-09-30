// Ported from upstream's markdownImageGallery. Coder keeps project-image wrappers in the gallery,
// because helper-read previews release offscreen bytes.
import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import type { ExpandedImagePreview } from "./ExpandedImageDialog";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";
type ExpandedImageItem = ExpandedImagePreview["images"][number];

// Weak keys retain resolved media only while the rendered image is reachable.
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

/** Collect in document order only when opened, including PR sections separated by videos. */
export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  // Keep project-image wrappers so navigation does not depend on which images finished loading.
  for (const image of scope?.querySelectorAll("[data-project-image], img") ?? []) {
    if (image.tagName === "IMG" && image.closest("[data-project-image]")) continue;
    const registered = markdownImageItems.get(image);
    if (!registered) continue;
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && href !== "#" && mediaKindFromPath(href) !== "image") continue;
    // An image linked to a web image opens the linked one, as on main.
    const linkedSource =
      resolveExternalWebLinkHost(href) !== null ? resolveProtocolRelativeMediaUrl(href) : null;
    const item = linkedSource ? { ...registered, src: linkedSource } : registered;
    if (
      image === element ||
      image.contains(element) ||
      (!markdownImageItems.has(element) && index < 0 && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else images.push(item);
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}
