import { readScreenshotBlob } from "../../lib/readScreenshotBlob";
import { imageResources, type ImageResourceState } from "./imageResources";
import { type EnvironmentId, type ScreenshotArtifactReference } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useReducer } from "react";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";

export function useScreenshotArtifacts(
  environmentId: EnvironmentId,
  artifacts: ReadonlyArray<Omit<ScreenshotArtifactReference, "sizeBytes"> & { sizeBytes?: number }>,
  expanded: boolean,
  source: "artifact" | "attachment" = "artifact",
) {
  "use no memo"; // Resource entries mutate outside React; each subscription notification must reread them.
  const readArtifact = useAtomCommand(projectEnvironment.readScreenshotArtifact, {
    reportFailure: false,
  });
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  // Equivalent references must share a subscription even when their caller recreates the array.
  const resourceKey = JSON.stringify(
    artifacts.map(({ id, mimeType, sizeBytes }) => ({ id, mimeType, sizeBytes })),
  );
  useEffect(() => {
    if (!expanded) return;
    const references = JSON.parse(resourceKey) as typeof artifacts;
    const releases = references.map((artifact) =>
      imageResources.subscribe(
        JSON.stringify([environmentId, source, artifact.id]),
        async (signal) => {
          return readScreenshotBlob(
            artifact,
            source,
            async (input) => {
              const result = await readArtifact({ environmentId, input });
              if (result._tag !== "Success") throw squashAtomCommandFailure(result);
              return result.value;
            },
            signal,
          );
        },
        rerender,
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [environmentId, source, resourceKey, expanded, readArtifact]);
  const images: Record<string, ImageResourceState> = {};
  if (expanded)
    for (const artifact of artifacts)
      images[artifact.id] = imageResources.get(
        JSON.stringify([environmentId, source, artifact.id]),
      );
  return images;
}
