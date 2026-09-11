// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const menu = vi.hoisted(() => ({ open: false }));
vi.mock("../../contextMenuFallback", () => ({ isContextMenuOpen: () => menu.open }));
let root: Root;
let host: HTMLDivElement;
const retry = vi.fn();
function Fixture({ failed = false }: { failed?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open gallery</button>
      {open && (
        <ExpandedImageDialog
          onClose={() => setOpen(false)}
          preview={{
            index: 0,
            images: [
              { src: failed ? null : "blob:first", name: "First", retry },
              { src: "blob:second", name: "Second" },
            ],
          }}
        />
      )}
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  menu.open = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function open(failed = false) {
  await act(async () => root.render(<Fixture failed={failed} />));
  const opener = host.querySelector("button")!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  return opener;
}
async function key(value: string, prevented = false) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  if (prevented) event.preventDefault();
  await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(event));
  return event;
}
it("wraps navigation, consumes arrows, and respects handled keys and context menus", async () => {
  await open();
  const alt = () => document.querySelector('[role="dialog"] img')?.getAttribute("alt");
  const listener = vi.fn();
  window.addEventListener("keydown", listener);
  try {
    expect((await key("ArrowLeft")).defaultPrevented).toBe(true);
    expect(alt()).toBe("Second");
    expect(listener.mock.calls[0]?.[0].cancelBubble).toBe(true);
    await key("ArrowRight");
    expect(alt()).toBe("First");
    await key("ArrowRight", true);
    expect(alt()).toBe("First");
    menu.open = true;
    await key("ArrowRight");
    expect(alt()).toBe("First");
    await key("Escape");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    window.removeEventListener("keydown", listener);
  }
});
it("marks the composer floating layer and restores opener focus after closing", async () => {
  const opener = await open();
  expect(
    document.querySelector('[role="dialog"]')?.getAttribute("data-chat-composer-floating-layer"),
  ).toBe("true");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it("closes with Escape and exposes transport retry for unavailable images", async () => {
  await open(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Image unavailable");
  await act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry image")!.click(),
  );
  expect(retry).toHaveBeenCalledOnce();
  await key("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
