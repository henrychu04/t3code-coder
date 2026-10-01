// Coder: the image-view tool activity's preview. Upstream renders `ChatMarkdownAssetImage` for a
// `media-file` resource; Coder keeps its project-relative target and backs the same component
// with helper stdio reads.
import { useState, type ReactNode } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function ProjectImageLink(props: {
  filePath: string | null;
  cwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  children: ReactNode;
  alt?: string | undefined;
  maxHeightRem?: number | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [localPreview, setLocalPreview] = useState<ExpandedImagePreview | null>(null);
  if (!props.filePath || !props.cwd || !props.threadRef)
    return <span title="Image preview unavailable">{props.children}</span>;
  return (
    <>
      <ChatMarkdownAssetImage
        environmentId={props.threadRef.environmentId}
        resource={{
          _tag: "media-file",
          threadId: props.threadRef.threadId,
          // Markdown reads absolute paths; resolving here shares one image-store entry.
          path: /^~?\//.test(props.filePath)
            ? props.filePath
            : `${props.cwd.replace(/\/+$/, "")}/${props.filePath.replace(/^\.\//, "")}`,
        }}
        alt={props.alt ?? props.filePath.split("/").at(-1) ?? "Image"}
        workspaceRoot={props.cwd}
        maxHeightRem={props.maxHeightRem}
        onImageExpand={props.onImageExpand ?? setLocalPreview}
      />
      {localPreview ? (
        <ExpandedImageDialog preview={localPreview} onClose={() => setLocalPreview(null)} />
      ) : null}
    </>
  );
}
