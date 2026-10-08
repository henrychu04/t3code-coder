/**
 * Coder: workspace attachments have no signed asset URLs. Submitted images are read by id through
 * the helper's bounded chunk reads and exposed as in-memory object URLs, so callers keep
 * upstream's `useAssetUrls` shape.
 */
import { type EnvironmentId, ScreenshotArtifactId } from "@t3tools/contracts";

import { useScreenshotArtifacts } from "../components/chat/useScreenshotArtifacts";
import { useConnectedEnvironmentIds } from "../state/environments";
import type { AttachmentImageResource } from "./attachmentImageResource";

export { type AttachmentImageResource, isAttachmentImageMimeType } from "./attachmentImageResource";

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AttachmentImageResource>,
): ReadonlyArray<string | null> {
  // Cached threads render before the workspace connects. Reads start once it is connected, and a
  // disconnect releases them so the next connection reads again instead of keeping a failure.
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const images = useScreenshotArtifacts(
    environmentId,
    resources.map((resource) => ({
      id: ScreenshotArtifactId.make(resource.attachmentId),
      name: resource.attachmentId,
      mimeType: resource.mimeType,
      ...(resource.sizeBytes === undefined ? {} : { sizeBytes: resource.sizeBytes }),
    })),
    connected && resources.length > 0,
    "attachment",
  );
  return resources.map((resource) => {
    const image = images[resource.attachmentId];
    return image?.status === "loaded" ? image.url : null;
  });
}
