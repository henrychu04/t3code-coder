import type { ExpandedImagePreview } from "./ExpandedImageDialog";
import type { EnvironmentId, ScreenshotArtifactReference, TurnId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

/** A one-shot request owned by the timeline, surviving gallery unmounts. */
export function createArtifactNavigationRequest(artifactId: string) {
  let consumed = false;
  return {
    artifactId,
    consume: () => {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}

export const ArtifactNavigationContext = createContext<{
  environmentId?: EnvironmentId;
  artifactsByTurn: ReadonlyMap<TurnId, ReadonlyArray<ScreenshotArtifactReference>>;
  reveal: (artifactId: string) => void;
  request: ReturnType<typeof createArtifactNavigationRequest> | null;
} | null>(null);
export const ArtifactTurnContext = createContext<TurnId | null>(null);

/** Compatibility gallery for artifacts saved by older versions. */
export function useTurnImageGallery() {
  const navigation = useContext(ArtifactNavigationContext);
  const turnId = useContext(ArtifactTurnContext);
  const observations = turnId ? navigation?.artifactsByTurn.get(turnId) : undefined;
  const seen = new Set<string>();
  const artifacts = (observations ?? []).filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
  return {
    artifacts,
    previewFor(artifactId: string): ExpandedImagePreview | null {
      const index = artifacts.findIndex((artifact) => artifact.id === artifactId);
      return index < 0
        ? null
        : {
            index,
            images: artifacts.map((artifact) => ({ src: null, name: artifact.name, artifact })),
          };
    },
  };
}
