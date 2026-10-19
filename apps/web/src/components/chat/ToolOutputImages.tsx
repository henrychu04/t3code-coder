/**
 * Coder: images a tool returned inline. Upstream loads each through a signed `tool-output-image`
 * asset URL; the helper reads them in bounded chunks into the shared image store instead.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ToolOutputImageResource } from "@t3tools/client-runtime/work-log/item-detail";

import { useAssetUrls } from "../../assets/assetUrls";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function ToolOutputImages(props: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ToolOutputImageResource>;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { environmentId, images } = props;
  const urls = useAssetUrls(environmentId, images);
  const loaded = urls.flatMap((url) =>
    url === null ? [] : [{ src: url, name: "Tool output image" }],
  );
  return images.map((image, index) => {
    const url = urls[index];
    if (url === null || url === undefined) {
      return (
        <div
          key={image.index}
          className="flex h-16 w-24 items-center justify-center rounded-md border border-border text-muted-foreground text-xs"
        >
          Image
        </div>
      );
    }
    return (
      <button
        key={image.index}
        type="button"
        className="block cursor-zoom-in"
        onClick={() =>
          props.onImageExpand?.({
            images: loaded,
            index: loaded.findIndex((item) => item.src === url),
          })
        }
      >
        <img
          src={url}
          alt="Tool output image"
          className="max-h-64 max-w-full rounded-md border border-border object-contain"
        />
      </button>
    );
  });
}
