/**
 * Coder: images a tool returned inline. Upstream loads each through a signed `tool-output-image`
 * asset URL; the helper reads them in bounded chunks into the shared image store instead.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ToolOutputImageResource } from "@t3tools/client-runtime/work-log/item-detail";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useReducer } from "react";

import { readTurnItemAsset } from "../../lib/readTurnItemAsset";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { imageResources } from "./imageResources";

const imageKey = (environmentId: EnvironmentId, image: ToolOutputImageResource) =>
  JSON.stringify([environmentId, image._tag, image.threadId, image.itemId, image.index]);

export function ToolOutputImages(props: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ToolOutputImageResource>;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  "use no memo"; // Resource entries mutate outside React; each notification must reread them.
  const { environmentId, images } = props;
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const readAsset = useAtomCommand(projectEnvironment.readTurnItemAsset, { reportFailure: false });
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const resourceKey = JSON.stringify(images);
  useEffect(() => {
    if (!connected) return;
    const references = JSON.parse(resourceKey) as ReadonlyArray<ToolOutputImageResource>;
    const releases = references.map((image) =>
      imageResources.subscribe(
        imageKey(environmentId, image),
        (signal) =>
          readTurnItemAsset(
            {
              threadId: image.threadId,
              itemId: image.itemId,
              asset: { _tag: "tool-output-image", index: image.index },
            },
            (mimeType) => mimeType.startsWith("image/"),
            async (input) => {
              const result = await readAsset({ environmentId, input });
              if (result._tag !== "Success") throw squashAtomCommandFailure(result);
              return result.value;
            },
            signal,
          ),
        rerender,
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [environmentId, resourceKey, connected, readAsset]);

  const urls = images.map((image) => {
    const state = connected ? imageResources.get(imageKey(environmentId, image)) : undefined;
    return state?.status === "loaded" ? state.url : null;
  });
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
