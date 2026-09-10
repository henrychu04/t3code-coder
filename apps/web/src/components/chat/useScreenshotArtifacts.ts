import { imageResources, type ImageResourceState } from "./imageResources";
import {
  type EnvironmentId,
  type ScreenshotArtifactReference,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useReducer } from "react";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
function decodeBase64Bytes(value: string): ArrayBuffer {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export function useScreenshotArtifacts(
  environmentId: EnvironmentId,
  artifacts: ReadonlyArray<Omit<ScreenshotArtifactReference, "sizeBytes"> & { sizeBytes?: number }>,
  expanded: boolean,
  source: "artifact" | "attachment" = "artifact",
) {
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
          const chunks: ArrayBuffer[] = [];
          let offset = 0;
          let totalBytes = artifact.sizeBytes;
          while (true) {
            signal.throwIfAborted();
            const result = await readArtifact({
              environmentId,
              input: {
                artifactId: artifact.id,
                source,
                offset,
                limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
              },
            });
            signal.throwIfAborted();
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            totalBytes ??= result.value.totalBytes;
            if (
              result.value.dataBase64.length >
              Math.ceil(MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES / 3) * 4
            )
              throw new Error("Invalid image chunk.");
            const chunk = decodeBase64Bytes(result.value.dataBase64);
            const nextOffset = offset + chunk.byteLength;
            if (
              result.value.offset !== offset ||
              result.value.totalBytes !== totalBytes ||
              !Number.isInteger(totalBytes) ||
              totalBytes <= 0 ||
              totalBytes > MAX_SCREENSHOT_ARTIFACT_BYTES ||
              result.value.mimeType !== artifact.mimeType ||
              result.value.artifactId !== artifact.id ||
              chunk.byteLength === 0 ||
              chunk.byteLength > MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES ||
              nextOffset > totalBytes ||
              (result.value.nextOffset !== null && result.value.nextOffset !== nextOffset)
            )
              throw new Error("Invalid image chunk.");
            chunks.push(chunk);
            if (result.value.nextOffset === null) {
              if (nextOffset !== totalBytes) throw new Error("Incomplete image.");
              break;
            }
            offset = nextOffset;
          }
          return new Blob(chunks, { type: artifact.mimeType });
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
