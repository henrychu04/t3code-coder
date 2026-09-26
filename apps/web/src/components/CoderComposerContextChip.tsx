import { formatAttachmentSize, formatAttachmentUploadProgress } from "~/lib/attachmentDisplay";
import { ImageChipButton, UnresolvedChip, ContextChipPopover } from "./contextChipParts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import ChatMarkdown from "./ChatMarkdown";
import { lazy, Suspense } from "react";
import { ContextChip, ContextChipLabel } from "./ContextChip";
const SourcePreview = lazy(() => import("./files/ReadOnlySourcePreview"));
import { useComposerImageThumbnail } from "../hooks/useComposerImageThumbnail";
// Inline context follows upstream's chip behavior while retaining Coder's prompt and image transport.
import { createContext, use, useEffect, useState } from "react";
import { MessageCircleIcon, FileTextIcon } from "lucide-react";
import {
  collectInlineComposerContexts,
  longTextContextReference,
} from "../lib/composerInlineContext";
import { EMPTY_PASTED_IMAGES, type ComposerPastedImage } from "../lib/composerPastedImages";
import { formatReviewCommentContext } from "../reviewCommentContext";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";

export const ComposerImagesContext =
  createContext<ReadonlyArray<ComposerPastedImage>>(EMPTY_PASTED_IMAGES);

export function CoderComposerContextChip({
  source,
  disabled,
  onSave,
}: {
  source: string;
  disabled: boolean;
  onSave: (source: string) => void;
}) {
  const images = use(ComposerImagesContext);
  const context = collectInlineComposerContexts(source)[0]?.context;
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const image =
    context?.kind === "image" ? images.find((image) => image.id === context.imageId) : undefined;
  const thumbnail = useComposerImageThumbnail(image?.file);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !image) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(image.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [open, image?.file]);
  if (!context) return <span>{source}</span>;
  const label =
    context.kind === "image"
      ? (image?.file.name ?? "Image unavailable")
      : context.kind === "text"
        ? `Long text · ${context.text.length.toLocaleString()} characters`
        : context.comment.text.trim() ||
          `${context.comment.filePath} ${context.comment.rangeLabel}`;

  const save = () => {
    if (context.kind === "image" || disabled) return;
    onSave(
      context.kind === "text"
        ? comment.length >= 32 * 1024
          ? longTextContextReference(comment)
          : comment
        : formatReviewCommentContext({ ...context.comment, text: comment }),
    );
    setOpen(false);
  };
  return (
    <>
      {context.kind === "image" ? (
        image ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ImageChipButton
                  name={image.file.name}
                  previewUrl={thumbnail ?? undefined}
                  size={formatAttachmentSize(image.file.size)}
                  suffix={
                    image.status === "uploading"
                      ? formatAttachmentUploadProgress(image.progress)
                      : image.status === "failed"
                        ? "upload failed"
                        : image.status === "queued"
                          ? "queued"
                          : null
                  }
                  onClick={() => setOpen(true)}
                />
              }
            />
            <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
              {[
                image.file.name,
                formatAttachmentSize(image.file.size),
                ...(image.status === "failed" ? ["", image.error] : []),
              ].join("\n")}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <UnresolvedChip
            label="Image unavailable"
            tooltip="This image is no longer available. Remove it or attach it again."
          />
        )
      ) : context.kind === "review-comment" ? (
        <ContextChipPopover
          kind="review-comment"
          icon={<MessageCircleIcon />}
          label={label}
          accessibleLabel={`Review comment, ${label}`}
        >
          <div className="space-y-2 overflow-hidden rounded-lg border border-border/70 bg-background/70 p-3">
            <div className="space-y-1">
              <div className="truncate text-xs font-medium">{context.comment.filePath}</div>
              <div className="text-secondary-label text-[11px]">
                {context.comment.sectionTitle} · {context.comment.rangeLabel}
              </div>
            </div>
            {context.comment.text.trim() ? (
              <ChatMarkdown text={context.comment.text.trim()} cwd={undefined} />
            ) : null}
            {context.comment.diff.trim() ? (
              <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md border border-border">
                <Suspense fallback={<span className="p-3 text-xs">Loading source…</span>}>
                  <SourcePreview name="review.diff" text={context.comment.diff} />
                </Suspense>
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setComment(context.comment.text);
                setOpen(true);
              }}
            >
              Edit comment
            </Button>
          </div>
        </ContextChipPopover>
      ) : (
        <ContextChip
          kind="file"
          render={<button type="button" />}
          aria-label={`Long text: ${label}`}
          onClick={() => {
            setComment(context.text);
            setOpen(true);
          }}
        >
          <FileTextIcon />
          <ContextChipLabel>{label}</ContextChipLabel>
        </ContextChip>
      )}

      {open && context.kind === "image" && image && url ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: url, name: image.file.name }], index: 0 }}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {context.kind !== "image" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup className="max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {context.kind === "text"
                  ? "Long text"
                  : `${context.comment.filePath} · ${context.comment.rangeLabel}`}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 px-6 pb-4">
              <textarea
                aria-label={context.kind === "text" ? "Long text" : "Review comment"}
                className="min-h-20 w-full rounded border bg-background p-2 text-sm"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              {context.kind === "review-comment" ? (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                  {context.comment.diff}
                </pre>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save}>Save</Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
