// Ported from upstream 8d8189e67; external link overrides are excluded by the Coder boundary.
import type { ExpandedImagePreview } from "./ExpandedImageDialog";
type ExpandedImageItem = ExpandedImagePreview["images"][number];
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();
export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("img") ?? []) {
    const item = markdownImageItems.get(image);
    if (!item) continue;
    if (
      image === element ||
      (!markdownImageItems.has(element) && index < 0 && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else images.push(item);
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}
