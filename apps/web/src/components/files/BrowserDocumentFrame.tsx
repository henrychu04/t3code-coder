/**
 * Coder: upstream's document frames, fed by bytes the helper read rather than a signed asset URL.
 *
 * HTML is written into the gateway's sandboxed document shell, as MCP Apps are: a blob, srcdoc,
 * or data: frame would inherit the app page's Content-Security-Policy and block the page's own
 * scripts. The shell's CSP sandbox gives the page an opaque origin even if the shell is opened
 * directly. Agent renders use the MCP App shell (upstream's `allow-scripts allow-forms`); HTML
 * files use the document shell, which adds `allow-popups allow-downloads` as upstream's file frame
 * does. A PDF
 * opens from a memory-only blob in the browser's built-in viewer, which needs an unsandboxed
 * frame; a PDF runs no scripts in the app's origin.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type KeybindingCommand,
  type KeybindingShortcut,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ScopedThreadRef,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import {
  type HtmlRenderShortcut,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  normalizeEventKey,
} from "@t3tools/shared/keybindings";
import { HTML_DOCUMENT_FRAME_PATH, MCP_APP_FRAME_PATH } from "@t3tools/shared/mcpApp";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { shortcutConflictKey } from "~/keybindings";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

// Coder: PDFs stay in the built-in viewer's frame, because the gateway's CSP sets
// `object-src 'none'`, which blocks upstream's `<embed>`.
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

/**
 * The page reports the keys, and a page script can report any key it likes,
 * so only commands that change what the reader sees are here, never one that
 * changes a thread.
 */
const HTML_RENDER_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  "chat.find",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
  "terminal.toggle",
  "preview.toggle",
  "navigation.back",
  "navigation.forward",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
]);

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/** Renders an HTML or PDF document: `pdfUrl` is a blob URL, `html` the page's source. */
export function BrowserDocumentFrame(
  props:
    | { readonly pdfUrl: string; readonly title: string }
    | {
        readonly html: string;
        readonly title: string;
        readonly htmlRender?: boolean;
        /** The thread an HTML render's links open beside. */
        readonly threadRef?: ScopedThreadRef | undefined;
      },
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
    <HtmlRenderDocument
      key={props.html}
      html={props.html}
      title={props.title}
      threadRef={props.threadRef}
      className="min-h-0 flex-1"
    />
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
 * The source is written once for the frame's lifetime.
 */
export function HtmlRenderDocument(props: {
  readonly html: string;
  readonly title: string;
  readonly className?: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onContentHeight?: (height: number) => void;
  /** Reports the image viewer opening and closing, so a virtualized row can stay mounted. */
  readonly onFullscreenChange?: ((fullscreen: boolean) => void) | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${MCP_APP_FRAME_PATH}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const written = useRef(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentKeybindings = useAtomValue(
    serverEnvironment.configValueAtom(props.threadRef?.environmentId ?? null),
  )?.keybindings;
  // The app resolves a replayed key in its live context, so every allowed
  // binding counts whatever its `when`, and a key that any binding gives to
  // another command stays with the page. Only Cmd/Ctrl chords: a printable key
  // would type into the composer instead.
  const mac = isMacPlatform(navigator.platform);
  const resolve = (shortcut: KeybindingShortcut): HtmlRenderShortcut => ({
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  });
  const blocked = [...keybindings, ...(environmentKeybindings ?? [])]
    .filter((binding) => !HTML_RENDER_SHORTCUT_COMMANDS.has(binding.command))
    .map((binding) => resolve(binding.shortcut));
  const shortcutsByKey = new Map<string, HtmlRenderShortcut>();
  for (const { command, shortcut } of keybindings) {
    if (
      HTML_RENDER_SHORTCUT_COMMANDS.has(command) &&
      (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
    ) {
      shortcutsByKey.set(shortcutConflictKey(shortcut), resolve(shortcut));
    }
  }
  const shortcuts = [...shortcutsByKey.values()];
  const postShortcuts = () => {
    frameRef.current?.contentWindow?.postMessage(
      htmlRenderShortcutsMessage(shortcuts, blocked),
      "*",
    );
  };
  useEffect(postShortcuts, [blocked, shortcuts]);
  // The page reports the key and code, and a page script can report any pair,
  // so a key that could match another command's binding is never replayed. A
  // named key (Backspace, Enter) must be the shortcut's own, since some app
  // handlers read `event.key` directly.
  const isShortcut = useEffectEvent(
    (key: NonNullable<ReturnType<typeof readHtmlRenderKeyDown>>) => {
      const matches = (shortcut: HtmlRenderShortcut) =>
        matchesKeybindingShortcut(key, { ...shortcut, modKey: false }, navigator.platform);
      const allowed = shortcuts.filter(matches);
      return (
        allowed.length > 0 &&
        !blocked.some(matches) &&
        (key.key.length === 1 ||
          key.key === "Dead" ||
          allowed.some((shortcut) => shortcut.key === normalizeEventKey(key.key)))
      );
    },
  );
  const openChangeRequestLink = useOpenChangeRequestLink(props.threadRef);
  const openLink = useOpenLink(props.threadRef);
  const open = useEffectEvent((url: string, modifiers: { metaKey: boolean; ctrlKey: boolean }) => {
    if (modifiers.metaKey || modifiers.ctrlKey) {
      void readLocalApi()
        ?.shell.openExternal(url)
        .catch((cause: unknown) => console.error(cause));
      return;
    }
    if (
      props.threadRef !== undefined &&
      openChangeRequestLink(
        { ...modifiers, preventDefault: () => undefined, stopPropagation: () => undefined },
        url,
        undefined,
        props.threadRef.environmentId,
      )
    ) {
      return;
    }
    void openLink(url, { event: modifiers }).catch((cause: unknown) => console.error(cause));
  });
  // It asks the client, which opens the link only while this frame has focus
  // and the reader has just used the app. A page can take focus by script, so
  // this stops opens on load, not a page that waits for the reader's next click
  // or key.
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
      open(request.url, request);
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  useEffect(() => {
    const replayKey = (event: MessageEvent) => {
      const frame = frameRef.current;
      const key = readHtmlRenderKeyDown(event.data);
      if (
        key === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      if (!isShortcut(key)) return;
      frame.dispatchEvent(
        new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
      );
    };
    window.addEventListener("message", replayKey);
    return () => window.removeEventListener("message", replayKey);
  }, []);
  // A clicked page image opens in the same viewer as chat images, gated like a link.
  useEffect(() => {
    const openImage = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderImageRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      setExpandedImage({ images: [{ src: request.src, name: request.name }], index: 0 });
    };
    window.addEventListener("message", openImage);
    return () => window.removeEventListener("message", openImage);
  }, []);
  const { onFullscreenChange } = props;
  useEffect(() => {
    if (expandedImage === null) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expandedImage, onFullscreenChange]);
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
    <>
      <iframe
        ref={frameRef}
        src={src}
        title={props.title}
        // Coder: the shell's CSP sandbox applies; see the file header.
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
          postShortcuts();
        }}
        // A frame whose color scheme differs from its document's paints an opaque
        // canvas, so the blank document a frame starts with would flash white in
        // dark mode. Once the page is in, its prefers-color-scheme follows the app.
        className={cn("border-0 scheme-light", props.className)}
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
      {expandedImage !== null ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </>
  );
}
