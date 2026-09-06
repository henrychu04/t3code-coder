import {
  type EnvironmentId,
  type ScreenshotArtifactReference,
  MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
type ScreenshotImageState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "loaded"; readonly url: string };

function decodeBase64Bytes(value: string): ArrayBuffer {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export function useScreenshotArtifacts(
  environmentId: EnvironmentId,
  artifacts: ReadonlyArray<ScreenshotArtifactReference>,
  expanded: boolean,
) {
  const readArtifact = useAtomCommand(projectEnvironment.readScreenshotArtifact, {
    reportFailure: false,
  });
  const [images, setImages] = useState<Record<string, ScreenshotImageState>>({});
  const objectUrlsRef = useRef(new Set<string>());
  const requestedArtifactIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    for (const artifact of artifacts) {
      if (requestedArtifactIdsRef.current.has(artifact.id)) continue;
      requestedArtifactIdsRef.current.add(artifact.id);
      setImages((current) => ({ ...current, [artifact.id]: { status: "loading" } }));
      void (async () => {
        try {
          const chunks: ArrayBuffer[] = [];
          let offset = 0;
          let receivedBytes = 0;
          while (true) {
            const result = await readArtifact({
              environmentId: environmentId,
              input: {
                artifactId: artifact.id,
                offset,
                limit: MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES,
              },
            });
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            const chunk = decodeBase64Bytes(result.value.dataBase64);
            const expectedNextOffset = offset + chunk.byteLength;
            if (
              result.value.offset !== offset ||
              result.value.totalBytes !== artifact.sizeBytes ||
              chunk.byteLength === 0 ||
              expectedNextOffset > artifact.sizeBytes ||
              (result.value.nextOffset !== null && result.value.nextOffset !== expectedNextOffset)
            ) {
              throw new Error("Invalid screenshot artifact chunk.");
            }
            chunks.push(chunk);
            receivedBytes = expectedNextOffset;
            if (result.value.nextOffset === null) {
              if (receivedBytes !== artifact.sizeBytes) {
                throw new Error("Incomplete screenshot artifact.");
              }
              break;
            }
            offset = result.value.nextOffset;
          }
          const url = URL.createObjectURL(new Blob(chunks, { type: artifact.mimeType }));
          if (!mountedRef.current) {
            URL.revokeObjectURL(url);
            return;
          }
          objectUrlsRef.current.add(url);
          setImages((current) => ({
            ...current,
            [artifact.id]: { status: "loaded", url },
          }));
        } catch {
          if (!mountedRef.current) return;
          setImages((current) => ({ ...current, [artifact.id]: { status: "error" } }));
        }
      })();
    }
  }, [environmentId, artifacts, expanded, readArtifact]);

  return images;
}
