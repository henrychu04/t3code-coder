import { ScreenshotArtifactDimensions, type ScreenshotArtifactReference } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Reserve the same bounded frame while the user-requested artifact bytes load. */
export function ScreenshotArtifactPreview({
  artifact,
  image,
}: {
  readonly artifact: ScreenshotArtifactReference;
  readonly image?:
    | { readonly status: "loading" | "error" }
    | { readonly status: "loaded"; readonly url: string }
    | undefined;
}) {
  // Activity payloads may be old or malformed; dimensions are only a layout hint.
  const dimensions = Schema.is(ScreenshotArtifactDimensions)(artifact.dimensions)
    ? artifact.dimensions
    : undefined;
  return (
    <div
      className="flex max-h-48 items-center justify-center overflow-hidden bg-background/70"
      style={{ aspectRatio: dimensions ? `${dimensions.width} / ${dimensions.height}` : "16 / 9" }}
    >
      {image?.status === "loaded" ? (
        <img
          alt={artifact.name}
          className="size-full object-contain"
          draggable={false}
          width={dimensions?.width}
          height={dimensions?.height}
          src={image.url}
        />
      ) : image?.status === "error" ? (
        <span className="px-2 text-center text-destructive text-xs">Unavailable</span>
      ) : (
        <span className="text-muted-foreground text-xs">Loading…</span>
      )}
    </div>
  );
}
