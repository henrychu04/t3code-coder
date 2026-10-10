/**
 * Coder: upstream's document frames, fed by bytes the helper read rather than a signed asset URL.
 *
 * HTML is written into the gateway's sandboxed document shell, as MCP Apps are: a blob, srcdoc,
 * or data: frame would inherit the app page's Content-Security-Policy and block the page's own
 * scripts. The shell's CSP sandbox gives the page an opaque origin even if the shell is opened
 * directly. Agent renders use the MCP App shell (upstream's `allow-scripts allow-forms`); HTML
 * files use the document shell, which adds `allow-popups` as upstream's file frame does. A PDF
 * opens from a memory-only blob in the browser's built-in viewer, which needs an unsandboxed
 * frame; a PDF runs no scripts in the app's origin.
 */
import {
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import { HTML_DOCUMENT_FRAME_PATH, MCP_APP_FRAME_PATH } from "@t3tools/shared/mcpApp";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width. Pinch and keyboard zoom, scrolling, text
 * selection and find still work inside the frame.
 */
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/** Renders an HTML or PDF document: `pdfUrl` is a blob URL, `html` the page's source. */
export function BrowserDocumentFrame(
  props:
    | { readonly pdfUrl: string; readonly title: string }
    | { readonly html: string; readonly title: string; readonly htmlRender?: boolean },
) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  if ("pdfUrl" in props) {
    return (
      // oxlint-disable-next-line react/iframe-missing-sandbox -- the built-in PDF viewer needs an unsandboxed frame.
      <iframe
        key={props.pdfUrl}
        src={`${props.pdfUrl}${PDF_VIEWER_FRAGMENT}`}
        title={props.title}
        className={className}
      />
    );
  }
  return props.htmlRender ? (
    <HtmlRenderDocument html={props.html} title={props.title} className="min-h-0 flex-1" />
  ) : (
    <ShellDocument
      key={props.html}
      html={props.html}
      title={props.title}
      shellPath={HTML_DOCUMENT_FRAME_PATH}
      className={className}
    />
  );
}

/** A page written into a gateway document shell once the shell has loaded. */
function ShellDocument(props: {
  readonly html: string;
  readonly title: string;
  readonly shellPath: string;
  readonly className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const written = useRef(false);
  return (
    // Never allow-same-origin: the shell's CSP sandbox keeps the page out of the app's session.
    <iframe
      ref={frameRef}
      src={props.shellPath}
      title={props.title}
      className={props.className}
      onLoad={() => {
        if (written.current) return;
        written.current = true;
        frameRef.current?.contentWindow?.postMessage({ html: props.html }, "*");
      }}
    />
  );
}

/**
 * A sandboxed agent HTML render in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The source is written once for the frame's lifetime.
 */
export function HtmlRenderDocument(props: {
  readonly html: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${MCP_APP_FRAME_PATH}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const written = useRef(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // The page cannot open windows itself. It asks the client, which opens
  // the link only while this frame has focus and the reader has just used the
  // app. A page can take focus by script, so this stops opens on load, not a
  // page that waits for the reader's next click or key.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  const { onContentHeight } = props;
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could run after a fast page's first post.
  useLayoutEffect(() => {
    if (onContentHeight === undefined) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        onContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      loading="lazy"
      onLoad={() => {
        if (!written.current) {
          // The first load is the shell; it replaces itself with the page.
          written.current = true;
          frameRef.current?.contentWindow?.postMessage({ html: props.html }, "*");
          return;
        }
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className={cn("border-0 scheme-light", props.className)}
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
