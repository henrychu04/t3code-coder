// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";

import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { openLink, openChangeRequestLink } = vi.hoisted(() => ({
  openLink: vi.fn(),
  openChangeRequestLink: vi.fn(),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/lib/openPullRequestLink", () => ({
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));
// Coder: the frame reads its page through the helper, not a signed asset URL.
vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () => [EnvironmentId.make("environment")],
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/lib/readTurnItemAsset", () => ({
  readTurnItemAsset: async () => new Blob(["<p>Diagram</p>"], { type: "text/html" }),
}));

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  openLink.mockReset().mockResolvedValue(undefined);
  openChangeRequestLink.mockReset().mockReturnValue(false);
  onClose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <HtmlRenderDialog
        html="<p>Diagram</p>"
        title="Diagram"
        onClose={onClose}
      />,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}

it("zooms the loaded page within bounds and resets without reloading it", async () => {
  const frame = document.querySelector("iframe")!;
  const src = frame.src;
  for (let step = 0; step < 6; step += 1) await click("Zoom in");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("2");
  for (let step = 0; step < 8; step += 1) await click("Zoom out");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("0.5");
  await click("Reset zoom");
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("1");
  expect(document.querySelector("iframe")).toBe(frame);
  expect(frame.src).toBe(src);
  // Coder: the gateway's document shell applies the sandbox through its CSP.
});

it("closes with the close button or Escape", async () => {
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onClose).toHaveBeenCalledOnce();
});

async function renderInline() {
  // Async so a URL minted at mount lands inside act.
  await act(async () =>
    root.render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
      />,
    ),
  );
  // Coder: the page arrives from the helper read after the first render.
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
}

// Coder: the page is already in memory, so full screen opens it without a fresh URL.
it("offers only full screen and opens the page while keeping the inline page loaded", async () => {
  await renderInline();
  expect(document.querySelector('[aria-label="Open in panel"]')).toBeNull();
  const inlineFrame = document.querySelector("iframe")!;
  const originalSrc = inlineFrame.src;
  const expandButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open full screen"]',
  )!;
  expandButton.focus();
  await click("Open full screen");
  expect(document.querySelector('[role="dialog"] iframe')).not.toBeNull();
  expect(inlineFrame.src).toBe(originalSrc);
  await click("Close");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("iframe")).toBe(inlineFrame);
  expect(document.activeElement).toBe(expandButton);
});

it("routes links from the expanded page through its thread", async () => {
  await renderInline();
  openChangeRequestLink.mockReturnValue(true);
  await click("Open full screen");
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  frame.focus();
  const url = "https://github.com/pingdotgg/t3code/pull/17561";
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url } },
      }),
    );
  });
  expect(openChangeRequestLink).toHaveBeenCalledWith(
    expect.objectContaining({ metaKey: false, ctrlKey: false }),
    url,
    undefined,
    EnvironmentId.make("environment"),
  );
  expect(openLink).not.toHaveBeenCalled();
});

// Coder: upstream's unavailable-URL and near-expiry fresh-URL tests are not carried; full screen
// opens the page the frame already holds, so there is no URL to mint or fail.
