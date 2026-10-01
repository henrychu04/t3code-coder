// Legacy screenshot artifacts saved by older Coder versions, shown in main's gallery.
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useTurnImageGallery } from "./ArtifactNavigation";
import { useScreenshotArtifacts } from "./useScreenshotArtifacts";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

// Coder transport adapter: the upstream presentation receives current URLs even after retry.
export function CapturedImageDialog({
  environmentId,
  preview,
  onClose,
  source = "artifact",
}: {
  environmentId: EnvironmentId;
  preview: ExpandedImagePreview;
  onClose: () => void;
  source?: "artifact" | "attachment";
}) {
  const turnGallery = useTurnImageGallery();
  const initialArtifact = preview.images[preview.index]?.artifact;
  const galleryImages =
    (source === "artifact" && initialArtifact
      ? turnGallery.previewFor(initialArtifact.id)?.images
      : undefined) ?? preview.images;
  const [selectedId, setSelectedId] = useState(initialArtifact?.id);
  const index = Math.max(
    0,
    galleryImages.findIndex((image) => image.artifact?.id === selectedId),
  );
  const item = galleryImages[index];
  // Keep selection stable as turn activities change; select the first remaining
  // image if the selected artifact itself disappears.
  if (item?.artifact && item.artifact.id !== selectedId) setSelectedId(item.artifact.id);
  const artifacts = item?.artifact ? [item.artifact] : [];
  const resources = useScreenshotArtifacts(environmentId, artifacts, true, source, true);
  return (
    <ExpandedImageDialog
      onClose={onClose}
      onIndexChange={(nextIndex) => setSelectedId(galleryImages[nextIndex]?.artifact?.id)}
      preview={{
        ...preview,
        index,
        images: galleryImages.map((item) => {
          const resource = item.artifact ? resources[item.artifact.id] : undefined;
          return item.artifact
            ? {
                ...item,
                src: resource?.status === "loaded" ? resource.url : null,
                loading:
                  !resource || resource.status === "loading" || resource.status === "deferred",
                retry: resource && "retry" in resource ? resource.retry : undefined,
              }
            : item;
        }),
      }}
    />
  );
}
