import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { ChevronRightIcon, DownloadIcon, Trash2Icon, WrapTextIcon, XIcon } from "lucide-react";
import { Check, Code2, Copy, Eye, Table2 } from "lucide";
import { lazy, Suspense, useEffect, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { formatAttachmentSize } from "~/lib/attachmentDisplay";
import { saveBlob } from "~/lib/readAttachmentFile";
import { cn } from "~/lib/utils";

import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));

/** Highlighted read-only source, loaded on demand so message rendering never waits on the highlighter. */
export function ReadOnlySourcePreview(props: { name: string; text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourcePreview {...props} />
    </Suspense>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

/**
 * A draft attachment shown with the same chrome as a workspace file: one header row with crumbs
 * and icon actions, then the document.
 *
 * Coder: previews bytes already in browser memory (a draft file, a sent file or an agent's HTML
 * render the helper read) in place of upstream's signed asset URL, and saves those bytes.
 */
export function AttachmentFilePreview(props: {
  name: string;
  mimeType: string;
  /** Zero when unknown. */
  sizeBytes: number;
  file: Blob;
  /** An agent's HTML render, shown in the app theme. */
  htmlRender?: boolean;
  /** First crumb: where the file comes from. */
  origin?: string;
  onRemove?: () => void;
  onClose?: () => void;
}) {
  const kind = filePreviewKind(props);
  const delimiter = filePreviewDelimiter(props);
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.name });
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading source is a separate failure from loading the file: a rendered HTML page can be
  // fine while its bytes are not UTF-8, and switching back to the page must not stay stuck.
  const [contentError, setContentError] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(props.file);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish an object URL only after its cleanup is registered for this Blob.
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  const url = localUrl;
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  // Coder: a rendered page needs its whole source, which the bounded text preview may cut.
  const [pageHtml, setPageHtml] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "html") return;
    let cancelled = false;
    void props.file.text().then(
      (text) => {
        if (!cancelled) setPageHtml(text);
      },
      () => {
        if (!cancelled) setError("Could not load this page.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, props.file]);
  useEffect(() => {
    if (!needsText || !url) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new resource must clear the previous response before loading.
    setContent(null);
    setContentError(null);
    const file = props.file;
    void (async () => {
      const result = await readFilePreviewResponse(
        { ok: true, body: file.stream() },
        controller.signal,
      );
      if (!controller.signal.aborted) setContent(result);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setContentError(cause instanceof Error ? cause.message : "Could not load this file.");
    });
    return () => controller.abort();
  }, [url, needsText, revision, props.file]);
  const failure = error ?? (needsText ? contentError : null);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const updateClientSettings = useUpdateClientSettings();
  // Only the raw-text body honours word wrap. A rendered table or Markdown lays itself out,
  // so offering the toggle there would be a control that visibly does nothing.
  const showsRawText =
    failure === null &&
    needsText &&
    content !== null &&
    !(delimiter && rendered) &&
    !(kind === "markdown" && rendered);

  const body = failure ? (
    <FileSurfaceFailure
      message={failure}
      onRetry={() => {
        // Clearing first lets a local Blob preview remount: its URL never changes, so the
        // revision bump alone would re-render the same failed element.
        setError(null);
        setRevision((value) => value + 1);
      }}
    />
  ) : !url || (needsText && !content) ? (
    <FileSurfaceLoading />
  ) : needsText && content ? (
    delimiter && rendered ? (
      <DelimitedTablePreview name={props.name} text={content.text} delimiter={delimiter} />
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <ChatMarkdown text={content.text} cwd={undefined} className="mx-auto max-w-4xl px-6 py-5" />
      </ScrollArea>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={content.text} />
    )
  ) : kind === "pdf" ? (
    <BrowserDocumentFrame pdfUrl={url} title={props.name} />
  ) : kind === "html" ? (
    pageHtml === null ? (
      <FileSurfaceLoading />
    ) : (
      <BrowserDocumentFrame
        html={pageHtml}
        title={props.name}
        htmlRender={props.htmlRender === true}
      />
    )
  ) : kind === "audio" ? (
    <AudioPreview src={url} name={props.name} onError={() => setError("Unable to load audio.")} />
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        playsInline
        src={url}
        aria-label={props.name}
        className="max-h-full max-w-full"
        onError={() => setError("Unable to load video.")}
      />
    </div>
  ) : kind === "image" ? (
    // oxlint-disable-next-line t3code/require-centered-scroll-gutter -- The image is capped at max-h-full max-w-full, so this never scrolls.
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={props.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setError("Unable to load image.")}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">No preview for this file</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Save it to open in an app that supports {props.name.split(".").at(-1) || "this format"}{" "}
        files.
      </p>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={cn(FILE_SURFACE_SUBHEADER_CLASS)} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span className="shrink-0 px-0.5 text-muted-foreground">
            {props.origin ?? "Attachment"}
          </span>
          <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {props.name}
          </span>
          {props.sizeBytes > 0 ? (
            <span className="ml-2 shrink-0 text-muted-foreground">
              {formatAttachmentSize(props.sizeBytes)}
            </span>
          ) : null}
        </div>
        {renderedMode ? (
          <FileSurfaceAction
            label={renderedToggleLabel(renderedMode, rendered)}
            pressed={rendered}
            onPress={() => setRendered((value) => !value)}
          >
            <MorphIcon
              className="size-3.5"
              icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
            />
          </FileSurfaceAction>
        ) : null}
        {showsRawText ? (
          <FileSurfaceAction
            label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            pressed={wordWrap}
            onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
          >
            <WrapTextIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {content ? (
          <FileSurfaceAction
            label={isCopied ? "Copied" : content.truncated ? "Copy preview" : "Copy contents"}
            onPress={() => copyToClipboard(content.text, undefined)}
          >
            <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
          </FileSurfaceAction>
        ) : null}
        {url ? (
          <FileSurfaceAction label="Save file" onPress={() => saveBlob(props.file, props.name)}>
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onRemove ? (
          <FileSurfaceAction label="Remove from draft" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onClose ? (
          <FileSurfaceAction label="Close" onPress={props.onClose}>
            <XIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {content?.truncated ? (
        <FileSurfaceNotice>
          Preview limited to the first 1 MB
          {props.sizeBytes > 0 ? ` of a ${props.sizeBytes.toLocaleString()} byte file` : ""}. Save
          the file to read it in full.
        </FileSurfaceNotice>
      ) : null}
      {body}
    </div>
  );
}
