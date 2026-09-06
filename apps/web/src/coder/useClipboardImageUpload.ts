import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { uploadCoderClipboardImage } from "./api";
import { coderWorkspaceIdForEnvironment } from "./environmentStore";

/** Upload only to the captured workspace, and publish paths only to the originating draft. */
export function useClipboardImageUpload(
  environmentId: EnvironmentId,
  target: string,
  onError: (message: string | null) => void,
) {
  const [isUploading, setIsUploading] = useState(false);
  const inFlight = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const upload = async (files: ReadonlyArray<File>, onUploaded: (paths: string[]) => void) => {
    if (inFlight.current) {
      onError("Wait for the current pasted image upload to finish.");
      return;
    }
    const workspaceId = coderWorkspaceIdForEnvironment(environmentId);
    if (workspaceId === null) {
      onError("The Coder workspace is not connected.");
      return;
    }
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        onError("Clipboard image must be PNG, JPEG, or WebP.");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        onError("Clipboard image exceeds the 20 MiB limit.");
        return;
      }
    }
    onError(null);
    inFlight.current = true;
    setIsUploading(true);
    const paths: string[] = [];
    const publish = () => {
      if (paths.length > 0) onUploaded(paths);
    };
    try {
      for (const file of files) paths.push(await uploadCoderClipboardImage(workspaceId, file));
      if (targetRef.current !== target) {
        onError("Image upload finished after you left the thread.");
        return;
      }
      publish();
    } catch (cause) {
      if (targetRef.current !== target) {
        onError("Image upload finished after you left the thread.");
        return;
      }
      publish();
      onError(cause instanceof Error ? cause.message : "Clipboard image upload failed.");
    } finally {
      inFlight.current = false;
      setIsUploading(false);
    }
  };
  return { isUploading, upload };
}
