// Coder transport for main's workspace videos. Main streams a signed media-file asset URL with
// byte ranges; Coder reads the file through bounded helper stdio chunks into a memory-only blob
// URL and hands it to main's MediaVideoPlayer. A whole-file read is not a cheap metadata preload,
// so inline videos load when the user presses play instead of when they scroll into view.
import { useState, type CSSProperties, type ReactNode } from "react";
import { PlayIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";
import { projectMediaActionFields } from "./projectMediaReference";
import { cn } from "../../lib/utils";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { useProjectVideo, type ProjectVideoSource } from "./useProjectVideo";

/** Main's video extensions; the helper additionally checks each file's signature. */
export const isVideoFilePath = isWorkspaceVideoPreviewPath;

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Main's inline ChatMarkdownVideo, preceded by a play card until the user asks for the bytes. */
export function ProjectMarkdownVideo(props: {
  readonly source: ProjectVideoSource;
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly videoClassName?: string | undefined;
}) {
  const [requested, setRequested] = useState(false);
  const { state, retry } = useProjectVideo(props.source, requested);
  if (!requested || state.status === "idle")
    return (
      <span
        className={cn("relative inline-block align-middle", props.className)}
        style={props.style}
        data-markdown-copy={props.copyMarkdown}
      >
        <button
          type="button"
          aria-label={props.alt ? `Play ${props.alt}` : "Play video"}
          onClick={() => setRequested(true)}
          className="flex aspect-video w-full cursor-pointer items-center justify-center rounded-lg bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon aria-hidden className="size-4 fill-current" />
          </span>
        </button>
      </span>
    );
  if (state.status === "loading")
    return (
      <span
        className={cn("relative inline-block align-middle", props.className)}
        style={props.style}
        data-markdown-copy={props.copyMarkdown}
      >
        <span
          role="status"
          aria-label="Loading video"
          className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted/60 text-xs text-muted-foreground tabular-nums"
        >
          {state.total > 0
            ? `${formatMegabytes(state.loaded)} / ${formatMegabytes(state.total)}`
            : null}
        </span>
      </span>
    );
  return (
    <MediaVideoPlayer
      src={state.status === "loaded" ? state.src : null}
      sourceFailed={state.status === "failed"}
      label={props.alt}
      autoPlay
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={props.className}
      videoClassName={props.videoClassName}
      onRetry={retry}
      actionsSource={{
        kind: "video",
        name: props.alt || "video",
        src: state.status === "loaded" ? state.src : null,
        ...projectMediaActionFields(props.source.environmentId, props.source.target),
      }}
    />
  );
}

/** A link or inline-code reference to a workspace video opens it in the media dialog, as on main. */
export function ProjectVideoLink(props: {
  readonly filePath: string;
  readonly cwd?: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!props.cwd || !props.threadRef)
    return <span title="Video preview unavailable">{props.children}</span>;
  const source: ProjectVideoSource = {
    environmentId: props.threadRef.environmentId,
    target: { threadId: props.threadRef.threadId, cwd: props.cwd, filePath: props.filePath },
  };
  const name = props.filePath.split("/").at(-1) || "video";
  return (
    <>
      <a
        href="#"
        title="Play video"
        className="cursor-pointer text-primary underline"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {props.children}
      </a>
      {open ? (
        <ExpandedImageDialog
          preview={{ index: 0, images: [{ src: null, name, type: "video", projectVideo: source }] }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
