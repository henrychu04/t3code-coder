/**
 * Coder: upstream's inline HTML render, with the page read through the helper's bounded turn-item
 * read (only the page the stored item references, in the item's own thread) instead of a signed
 * asset URL, and written into the gateway's sandboxed document shell. Full screen shows the same
 * in-memory page in upstream's dialog.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderOutlineBoxes,
  type HtmlRenderOutlineBox,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { readTurnItemAsset } from "~/lib/readTurnItemAsset";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
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
  const [html, setHtml] = useState<string | null>(null);
  // Coder: the page is already in memory, so full screen needs no fresh URL.
  const [expanded, setExpanded] = useState(false);
  const [ready, setReady] = useState(false);
  const showPage = () => setReady(true);
  const fitPage = (contentHeight: number) => {
    setContentHeight(contentHeight);
    setReady(true);
  };
  const { onFullscreenChange } = props;
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!connected || html !== null) return;
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
        setHtml(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [connected, html, props.environmentId, props.threadId, props.itemId, readAsset]);

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {!ready && !failed ? (
        <HtmlRenderSkeleton
          title={title}
          height={height}
          outline={htmlRenderOutlineBoxes(props.htmlRender, width)}
        />
      ) : null}
      {html !== null ? (
        <>
          <HtmlRenderDocument
            html={html}
            title={title}
            threadRef={props.threadRef}
            className={cn(
              "block size-full motion-safe:transition-opacity motion-safe:duration-200",
              !ready && "opacity-0",
            )}
            onContentHeight={fitPage}
            onLoad={showPage}
            onFullscreenChange={onFullscreenChange}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="glass"
                    onClick={() => setExpanded(true)}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
          {expanded ? (
            <HtmlRenderDialog
              html={html}
              title={title}
              threadRef={props.threadRef}
              onClose={() => setExpanded(false)}
            />
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

const SKELETON_SECTION_HEIGHT = 264;

const OUTLINE_BOX_CLASS = {
  media: "rounded-lg bg-muted-foreground/15",
  text: "",
  table: "",
} as const;

const OUTLINE_BAR = "color-mix(in srgb, var(--color-muted-foreground) 15%, transparent)";

function outlineBoxStyle(box: HtmlRenderOutlineBox): React.CSSProperties {
  const style: React.CSSProperties = {
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
  };
  if (box.kind !== "text" && box.kind !== "table") return style;
  const step = box.height / box.lines;
  const bar = Math.min(box.kind === "table" ? 12 : 10, step * 0.6);
  const start = (step - bar) / 2;
  return {
    ...style,
    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${start}px, ${OUTLINE_BAR} ${start}px ${start + bar}px, transparent ${start + bar}px ${step}px)`,
  };
}

function HtmlRenderSkeleton(props: {
  readonly title: string;
  readonly height: number;
  readonly outline: ReadonlyArray<HtmlRenderOutlineBox>;
}) {
  if (props.outline.length > 0) {
    return (
      <div
        role="status"
        aria-label={`Loading ${props.title}`}
        className="pointer-events-none absolute inset-0 overflow-hidden motion-safe:animate-skeleton"
      >
        {props.outline.map((box) => (
          <div
            key={`${box.kind}:${box.x}:${box.y}:${box.width}:${box.height}`}
            className={cn("absolute", OUTLINE_BOX_CLASS[box.kind])}
            style={outlineBoxStyle(box)}
          />
        ))}
      </div>
    );
  }
  const sections = Math.ceil(props.height / SKELETON_SECTION_HEIGHT);
  return (
    <div
      role="status"
      aria-label={`Loading ${props.title}`}
      className="pointer-events-none absolute inset-0 flex flex-col gap-6 overflow-hidden pt-1"
    >
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="flex shrink-0 flex-col gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton shape="card" className="mt-2 h-40 w-full" />
        </div>
      ))}
    </div>
  );
}
