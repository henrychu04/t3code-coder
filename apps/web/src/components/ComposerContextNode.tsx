import { formatAttachmentSize, formatAttachmentUploadProgress } from "~/lib/attachmentDisplay";
import { ImageChipButton, UnresolvedChip, ContextChipPopover } from "./contextChipParts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import ChatMarkdown from "./ChatMarkdown";
import { lazy, Suspense } from "react";
import { CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES } from "./composerInlineChip";
const SourcePreview = lazy(() => import("./files/ReadOnlySourcePreview"));
import { useComposerImageThumbnail } from "../hooks/useComposerImageThumbnail";
// Inline context follows upstream's chip behavior while retaining Coder's prompt and image transport.
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $createTextNode,
  $getNodeByKey,
  DecoratorNode,
  HISTORY_PUSH_TAG,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { createContext, use, useEffect, useState, type ReactElement } from "react";
import { MessageCircleIcon, FileTextIcon } from "lucide-react";
import {
  collectInlineComposerContexts,
  longTextContextReference,
} from "../lib/composerInlineContext";
import { EMPTY_PASTED_IMAGES, type ComposerPastedImage } from "../lib/composerPastedImages";
import { formatReviewCommentContext } from "../reviewCommentContext";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "./composerInlineChip";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";

export const ComposerImagesContext =
  createContext<ReadonlyArray<ComposerPastedImage>>(EMPTY_PASTED_IMAGES);

type SerializedContextNode = Spread<
  { source: string; type: "composer-context"; version: 1 },
  SerializedLexicalNode
>;

function ContextChip({ source, nodeKey }: { source: string; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  return (
    <CoderComposerContextChip
      source={source}
      disabled={!editor.isEditable()}
      onSave={(next) => {
        editor.update(
          () => {
            const node = $getNodeByKey(nodeKey);
            if (node instanceof ComposerContextNode && node.isAttached()) {
              if (collectInlineComposerContexts(next).length > 0)
                node.getWritable().__source = next;
              else node.replace($createTextNode(next));
            }
          },
          { tag: HISTORY_PUSH_TAG },
        );
      }}
    />
  );
}

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
                  className={COMPOSER_INLINE_CHIP_CLASS_NAME}
                  labelClassName={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}
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
            tooltipClassName="max-w-80 leading-tight"
            label="Image unavailable"
            className={COMPOSER_INLINE_CHIP_CLASS_NAME}
            labelClassName={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}
            tooltip="This image is no longer available. Remove it or attach it again."
          />
        )
      ) : context.kind === "review-comment" ? (
        <ContextChipPopover
          accessibleLabel={`Review comment, ${label}`}
          chip={
            <>
              <MessageCircleIcon className="size-3.5" />
              <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            </>
          }
          triggerClassName={`${COMPOSER_INLINE_CHIP_CLASS_NAME} ${CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES["review-comment"]}`}
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
        <button
          type="button"
          className={`${COMPOSER_INLINE_CHIP_CLASS_NAME} ${CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.file}`}
          aria-label={`Long text: ${label}`}
          onClick={() => {
            setComment(context.text);
            setOpen(true);
          }}
        >
          <FileTextIcon className="size-[1.17em] shrink-0" />
          <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
        </button>
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

export class ComposerContextNode extends DecoratorNode<ReactElement> {
  __source: string;
  static override getType() {
    return "composer-context";
  }
  static override clone(node: ComposerContextNode) {
    return new ComposerContextNode(node.__source, node.__key);
  }
  static override importJSON(node: SerializedContextNode) {
    return $createComposerContextNode(node.source);
  }
  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }
  override exportJSON(): SerializedContextNode {
    return {
      ...super.exportJSON(),
      source: this.getLatest().__source,
      type: "composer-context",
      version: 1,
    };
  }
  override createDOM() {
    const element = document.createElement("span");
    element.className = COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME;
    return element;
  }
  override updateDOM(): false {
    return false;
  }
  override getTextContent() {
    return this.getLatest().__source;
  }
  override isInline(): true {
    return true;
  }
  override decorate() {
    return <ContextChip source={this.__source} nodeKey={this.__key} />;
  }
}
export function $createComposerContextNode(source: string) {
  return $applyNodeReplacement(new ComposerContextNode(source));
}
