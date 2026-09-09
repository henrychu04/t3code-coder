// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";

it("resolves sanitized fragments inside the clicked message before other messages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <ChatMarkdown cwd={undefined} text={'<div id="details">Other message</div>'} />
          <ChatMarkdown
            cwd={undefined}
            text={'[Jump](#details)\n\n<div id="details">This message</div>'}
          />
        </>,
      ),
    );
    const targets = host.querySelectorAll<HTMLElement>("#user-content-details");
    expect(targets).toHaveLength(2);
    const otherScroll = vi.fn();
    const localScroll = vi.fn();
    targets[0]!.scrollIntoView = otherScroll;
    targets[1]!.scrollIntoView = localScroll;
    const anchor = host.querySelector<HTMLAnchorElement>('a[href="#details"]')!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(localScroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(otherScroll).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
