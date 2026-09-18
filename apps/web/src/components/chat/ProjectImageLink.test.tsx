// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectImageLink } from "./ProjectImageLink";
const { load, retry } = vi.hoisted(() => ({ load: vi.fn(), retry: vi.fn() }));
vi.mock("./useProjectImages", () => ({ useProjectImages: load }));
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  load.mockImplementation((_env, target, enabled) =>
    enabled && target ? { status: "loaded", url: `blob:${target.filePath}`, retry } : undefined,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("previews copied and renamed project files without captured activities or path associations", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/project"
          threadRef={threadRef}
          text={'[![Generated](copied.png "Figure")](copied.png) ![Renamed](/project/renamed.png)'}
        />,
      ),
    );
    expect(host.querySelectorAll("img")).toHaveLength(2);
    expect(load.mock.calls.some(([, target]) => target?.filePath === "copied.png")).toBe(true);
    expect(load.mock.calls.some(([, target]) => target?.filePath === "renamed.png")).toBe(true);
    await act(async () => {
      for (const image of host.querySelectorAll("img")) image.dispatchEvent(new Event("load"));
    });
    expect(host.querySelector('img[alt="Generated"]')?.getAttribute("title")).toBe("Figure");
    expect(host.querySelectorAll('a[title="Preview image"]')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLImageElement>('img[alt="Generated"]')!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(
      "blob:renamed.png",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it("opens file links on demand, reads outside-project images, and keeps external images inert", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/project"
          threadRef={threadRef}
          text={
            "[Open](new.png) ![Outside](/outside/image.png) ![Remote](https://example.com/a.png)"
          }
        />,
      ),
    );
    expect(
      load.mock.calls.some(
        ([, target, enabled]) => enabled && target.filePath === "/outside/image.png",
      ),
    ).toBe(true);
    expect(host.querySelector('img[alt="Remote"]')).toBeNull();
    expect(host.querySelectorAll('a[title="Preview image"]')).toHaveLength(1);
    await act(async () =>
      host.querySelector<HTMLAnchorElement>('a[title="Preview image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("blob:new.png");
    expect(
      load.mock.calls
        .filter(([, , enabled]) => enabled)
        .every(([, target]) => ["new.png", "/outside/image.png"].includes(target.filePath)),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it("shows a retry action for a missing file and preserves authored anchor IDs", async () => {
  load.mockReturnValue({ status: "error", retry });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/project"
          threadRef={threadRef}
          text={'<img id="figure" src="missing.png" alt="Missing" />'}
        />,
      ),
    );
    expect(host.querySelector("#user-content-figure")).not.toBeNull();
    expect(host.textContent).toContain("Image unavailable");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([true, false])(
  "keeps image dimensions when a preview scrolls away (header: %s)",
  async (hasHeader) => {
    let observe: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observe = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    load.mockReturnValue({ status: "loading" });
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = () =>
      root.render(
        <ProjectImageLink
          inline
          cwd="/project"
          threadRef={threadRef}
          filePath="copy.png"
          alt="Image"
        >
          Image
        </ProjectImageLink>,
      );
    try {
      await act(async () => render());
      await act(async () =>
        observe?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
      expect(host.textContent).toContain("Loading image");
      expect(host.querySelector('[data-image-preview] [role="button"]')?.className).toContain(
        "aspect-video",
      );
      load.mockReturnValue({
        status: "loaded",
        url: "blob:copy.png",
        dimensions: hasHeader ? { width: 64, height: 64 } : undefined,
        retry,
      });
      await act(async () => render());
      await act(async () => {
        const image = host.querySelector("img")!;
        Object.defineProperties(image, {
          naturalWidth: { value: 64 },
          naturalHeight: { value: 64 },
        });
        image.dispatchEvent(new Event("load"));
      });
      await act(async () =>
        observe?.(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
      const placeholder = host.querySelector<HTMLElement>('[data-image-preview] [role="button"]');
      expect(placeholder?.style.width).toBe("64px");
      expect(placeholder?.style.aspectRatio).toBe("64 / 64");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("explains unsupported formats without fetching or offering a futile retry", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/project"
          threadRef={threadRef}
          text="![Logo](/tmp/logo.svg) [Animation](movie.gif)"
        />,
      ),
    );
    expect(host.textContent).toContain("Unsupported image format. Use PNG, JPEG, or WebP.");
    expect(host.textContent).not.toContain("Retry image");
    expect(load).not.toHaveBeenCalled();
    expect(host.querySelector("a, img, button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps unloaded images in gallery navigation and loads the selected image on demand", async () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd="/project"
          threadRef={threadRef}
          text="![First](first.png) ![Second](/tmp/second.png)"
        />,
      ),
    );
    expect(host.querySelectorAll("img")).toHaveLength(0);
    expect(load.mock.calls.every(([, , enabled]) => !enabled)).toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Preview First"]')!.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(
      "blob:first.png",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(
      "blob:/tmp/second.png",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
