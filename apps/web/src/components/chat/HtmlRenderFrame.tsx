/**
 * Coder: upstream's inline HTML render, with the page read through the helper's bounded turn-item
 * read (only the page the stored item references, in the item's own thread) instead of a signed
 * asset URL, and written into the gateway's sandboxed document shell. "Open full size" shows the
 * same in-memory page with its source and saves it.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { readTurnItemAsset } from "~/lib/readTurnItemAsset";
import { observeResize } from "~/lib/observeResize";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at the agent's height until the page reports its own.
 * Loading and failure hold the same box so nothing below it moves.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly htmlRender: HtmlRenderReference;
}) {
  const { title } = props.htmlRender;
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  // Client fonts can wrap a page taller than its declared height; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);

  const connected = useConnectedEnvironmentIds().includes(props.environmentId);
  const readAsset = useAtomCommand(projectEnvironment.readTurnItemAsset, { reportFailure: false });
  const [page, setPage] = useState<Blob | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!connected || page !== null) return;
    const controller = new AbortController();
    const environmentId = props.environmentId;
    void readTurnItemAsset(
      { threadId: props.threadId, itemId: props.itemId, asset: { _tag: "html-render" } },
      (mimeType) => mimeType === "text/html",
      async (input) => {
        const result = await readAsset({ environmentId, input });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        return result.value;
      },
      controller.signal,
    )
      .then(async (blob) => {
        const text = await blob.text();
        if (controller.signal.aborted) return;
        setPage(blob);
        setHtml(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [connected, page, props.environmentId, props.threadId, props.itemId, readAsset]);

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {html !== null && page !== null ? (
        <>
          <HtmlRenderDocument
            html={html}
            title={title}
            className="block size-full"
            onContentHeight={setContentHeight}
          />
          <div className="absolute end-2 top-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full size"
                    size="icon-xs"
                    variant="glass"
                    onClick={() => setExpanded(true)}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full size</TooltipPopup>
            </Tooltip>
          </div>
          {expanded ? (
            <Dialog open onOpenChange={(open) => setExpanded(open)}>
              <DialogPopup
                className="h-[min(85vh,52rem)] max-w-5xl overflow-hidden"
                showCloseButton={false}
              >
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <AttachmentFilePreview
                  name={htmlRenderFileName(title)}
                  mimeType="text/html"
                  sizeBytes={page.size}
                  file={page}
                  htmlRender
                  origin="Page"
                  onClose={() => setExpanded(false)}
                />
              </DialogPopup>
            </Dialog>
          ) : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}
