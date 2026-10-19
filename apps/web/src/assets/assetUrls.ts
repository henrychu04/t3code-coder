/**
 * Coder: workspace images have no signed asset URLs. Each image is read through the helper's
 * bounded chunk reads and exposed as an in-memory object URL, so callers keep upstream's
 * `useAssetUrls` shape.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { assetEnvironment, type ImageAssetResource } from "../state/assets";
import { useConnectedEnvironmentIds } from "../state/environments";

export { type AttachmentImageResource, isAttachmentImageMimeType } from "./attachmentImageResource";

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<ImageAssetResource>,
): ReadonlyArray<string | null> {
  // Cached threads render before the workspace connects. Reads start once it is connected, and a
  // disconnect releases them so the next connection reads again instead of keeping a failure.
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: connected ? resources : [],
    }),
  );
  return resources.map((_resource, index) => {
    const result = results[index];
    return result?.status === "loaded" ? result.url : null;
  });
}
