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
import { ImageIcon, MessageCircleIcon, FileTextIcon } from "lucide-react";
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
  const Icon =
    context.kind === "image"
      ? ImageIcon
      : context.kind === "text"
        ? FileTextIcon
        : MessageCircleIcon;
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
      <button
        type="button"
        disabled={context.kind === "image" && !image}
        className={COMPOSER_INLINE_CHIP_CLASS_NAME}
        aria-label={`${context.kind === "image" ? "Image" : context.kind === "text" ? "Long text" : "Review comment"}: ${label}`}
        onClick={() => {
          if (context.kind !== "image")
            setComment(context.kind === "text" ? context.text : context.comment.text);
          setOpen(true);
        }}
      >
        {thumbnail ? (
          <img src={thumbnail} alt="" className="size-[1.17em] shrink-0 rounded object-cover" />
        ) : (
          <Icon className="size-[1.17em] shrink-0" />
        )}
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
      </button>
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
