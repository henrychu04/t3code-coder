// @vitest-environment jsdom
// Coder: there is no floating preview, so these cover only the details card inset below Find.

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";

const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    resize.callbacks.add(callback);
    return () => resize.callbacks.delete(callback);
  },
}));

let root: Root;
let container: HTMLDivElement;
let fontSize = 16;
let canvas: ReturnType<typeof useChatCanvas>;

function Probe() {
  const current = useChatCanvas();
  useLayoutEffect(() => {
    canvas = current;
  }, [current]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fontSize = 16;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    // A nonzero canvas origin catches viewport coordinates used as canvas coordinates.
    if (this.hasAttribute("data-thread-find-bar")) {
      const gap = 0.75 * fontSize;
      return new DOMRect(
        200 + 1800 - gap - 17.5 * fontSize,
        100 + gap,
        17.5 * fontSize,
        2.25 * fontSize,
      );
    }
    return new DOMRect(200, 100, 1800, 1000);
  });
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: "48px",
    width: "736px",
    minWidth: "640px",
  } as CSSStyleDeclaration);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  resize.callbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderFind(open: boolean) {
  await act(() =>
    root.render(
      <ChatCanvas composerOverlayElement={null} detailsCardTopInset={open ? 48 : 0}>
        {open ? <div data-thread-find-bar /> : null}
        <Probe />
      </ChatCanvas>,
    ),
  );
}

it.each([16, 24])(
  "keeps the details card below Find and releases its space on close at a %spx root font",
  async (size) => {
    fontSize = size;
    await renderFind(false);
    expect(canvas?.detailsCardTopInset).toBe(0);

    await renderFind(true);
    expect(canvas?.detailsCardTopInset).toBe(3 * size);

    await renderFind(false);
    expect(canvas?.detailsCardTopInset).toBe(0);

    await renderFind(true);
    expect(canvas?.detailsCardTopInset).toBe(3 * size);
  },
);

it("remeasures the open bar when its font size changes without resizing the canvas", async () => {
  await renderFind(true);
  expect(canvas?.detailsCardTopInset).toBe(48);

  fontSize = 24;
  await act(() => {
    for (const callback of resize.callbacks) callback();
  });
  expect(canvas?.detailsCardTopInset).toBe(72);
});
