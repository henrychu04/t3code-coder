import { ArtifactNavigationContext, useTurnImageGallery } from "./ArtifactNavigation";
import { type EnvironmentId, type ScreenshotArtifactReference } from "@t3tools/contracts";
import { memo, useState, useContext, useEffect, useRef } from "react";
import { ScreenshotArtifactPreview } from "./ScreenshotArtifactPreview";
import { useScreenshotArtifacts } from "./useScreenshotArtifacts";
import { CapturedImageDialog } from "./CapturedMarkdownImage";
import { useImagePreviewVisibility } from "./useImagePreviewVisibility";

export type ImagePreviewReference = Omit<ScreenshotArtifactReference, "sizeBytes"> & {
  sizeBytes?: number;
};
export const ScreenshotArtifactsRow = memo(function ScreenshotArtifactsRow({
  artifacts,
  environmentId,
  source = "artifact",
  previewOnly = false,
  onClose,
}: {
  artifacts: ReadonlyArray<ImagePreviewReference>;
  environmentId: EnvironmentId;
  source?: "artifact" | "attachment";
  previewOnly?: boolean;
  onClose?: () => void;
}) {
  const navigation = useContext(ArtifactNavigationContext);
  const turnGallery = useTurnImageGallery();
  const { previewRef, visible } = useImagePreviewVisibility();
  const rowRef = useRef<HTMLSpanElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    previewOnly ? (artifacts[0]?.id ?? null) : null,
  );
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(new Set());
  const images = useScreenshotArtifacts(environmentId, artifacts, visible && !previewOnly, source);
  useEffect(() => {
    const request = navigation?.request;
    if (
      !request ||
      !artifacts.some((artifact) => artifact.id === request.artifactId) ||
      !request.consume()
    )
      return;
    setSelectedId(request.artifactId);
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [navigation?.request, artifacts]);
  const selectedIndex = artifacts.findIndex((artifact) => artifact.id === selectedId);
  if (artifacts.length === 0) return null;
  return (
    <span ref={rowRef} className="block">
      {source === "artifact" && turnGallery.artifacts[0]?.id === artifacts[0]?.id ? (
        <button
          type="button"
          className="mb-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedId(artifacts[0]?.id ?? null)}
        >
          Images in this turn · {turnGallery.artifacts.length}
        </button>
      ) : null}
      {/* Upstream MessagesTimeline user-image grid, using Coder's bounded chunk loader. */}
      <span
        ref={previewRef}
        hidden={previewOnly}
        className={previewOnly ? "hidden" : "mb-2 grid max-w-[420px] grid-cols-2 gap-2"}
      >
        {artifacts.map((artifact) => {
          const image = images[artifact.id];
          const failed =
            image?.status === "error" || (image?.status === "loaded" && failedUrls.has(image.url));
          const retry = () => {
            if (image && "retry" in image) image.retry();
          };
          return (
            <span key={artifact.id} className="relative">
              <button
                key={artifact.id}
                type="button"
                data-artifact-id={artifact.id}
                className="w-full aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70 cursor-zoom-in"
                aria-label={`Preview ${artifact.name}`}
                onClick={() => setSelectedId(artifact.id)}
              >
                <ScreenshotArtifactPreview
                  artifact={artifact}
                  image={failed ? { status: "error" } : image}
                  onError={() => {
                    if (image?.status === "loaded")
                      setFailedUrls((current) => new Set([...current, image.url]));
                  }}
                />
              </button>
              {failed ? (
                <button type="button" className="block text-xs underline" onClick={retry}>
                  Retry image
                </button>
              ) : null}
            </span>
          );
        })}
      </span>
      {selectedIndex >= 0 ? (
        <CapturedImageDialog
          environmentId={environmentId}
          source={source}
          key={selectedId}
          onClose={() => {
            setSelectedId(null);
            onClose?.();
          }}
          preview={
            (source === "artifact" ? turnGallery.previewFor(selectedId!) : null) ?? {
              index: selectedIndex,
              images: artifacts.map((artifact) => ({ name: artifact.name, src: null, artifact })),
            }
          }
        />
      ) : null}
    </span>
  );
});
