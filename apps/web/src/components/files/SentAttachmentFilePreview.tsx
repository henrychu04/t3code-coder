/**
 * Coder: a sent file attachment in the right panel. Upstream's FilePreviewPanel loads it from a
 * signed asset URL; here the helper reads it by id into memory for the same preview and Save.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useReadAttachmentFile } from "~/lib/readAttachmentFile";
import type { ChatFileAttachment } from "~/types";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

export function SentAttachmentFilePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
}) {
  const { attachment } = props;
  const readAttachmentFile = useReadAttachmentFile(props.environmentId);
  const [state, setState] = useState<{ blob: Blob } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new read clears the previous result.
    setState(null);
    void readAttachmentFile(attachment, controller.signal).then(
      (blob) => {
        if (!controller.signal.aborted) setState({ blob });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setState({
            error: cause instanceof Error ? cause.message : "The attachment is unavailable.",
          });
      },
    );
    return () => controller.abort();
  }, [attachment, readAttachmentFile, attempt]);

  if (state === null) return <FileSurfaceLoading />;
  if ("error" in state)
    return <FileSurfaceFailure message={state.error} onRetry={() => setAttempt((n) => n + 1)} />;
  return (
    <AttachmentFilePreview
      name={attachment.name}
      mimeType={attachment.mimeType}
      sizeBytes={attachment.sizeBytes}
      file={state.blob}
      htmlRender={attachment.htmlRender === true}
    />
  );
}
