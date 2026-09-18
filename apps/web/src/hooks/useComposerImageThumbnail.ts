import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { createComposerImageThumbnail } from "../lib/composerImageThumbnail";

export function useComposerImageThumbnail(file: File | undefined): string | undefined {
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (!file || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return;
    let disposed = false;
    let url: string | undefined;
    void createComposerImageThumbnail(file).then((thumbnail) => {
      if (disposed) return;
      url = URL.createObjectURL(thumbnail ?? file);
      setPreview({ file, url });
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  return preview?.file === file ? preview?.url : undefined;
}
