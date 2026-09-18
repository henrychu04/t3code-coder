// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ScreenshotArtifactId, TurnId } from "@t3tools/contracts";
import { CapturedMarkdownImage, CapturedImageDialog } from "./CapturedMarkdownImage";
import { ArtifactNavigationContext, ArtifactTurnContext } from "./ArtifactNavigation";
import { authoredImageSizeStyle } from "./markdownImageLayout";
const mocks = vi.hoisted(() => ({ retry: vi.fn(), failed: false, deferred: false }));
vi.mock("./useScreenshotArtifacts", () => ({
  useScreenshotArtifacts: (_env: unknown, artifacts: { id: string }[]) =>
    Object.fromEntries(
      artifacts.map(({ id }) => [
        id,
        mocks.deferred
          ? { status: "deferred" }
          : mocks.failed
            ? { status: "error", retry: mocks.retry }
            : { status: "loaded", url: `blob:${id}`, retry: mocks.retry },
      ]),
    ),
}));
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  mocks.failed = false;
  mocks.deferred = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("preserves authored sizing and browses registered images in message order", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <div className="chat-markdown">
          {["first", "second"].map((id) => (
            <CapturedMarkdownImage
              key={id}
              environmentId={EnvironmentId.make("env")}
              artifact={{
                id: ScreenshotArtifactId.make(id),
                name: `${id}.png`,
                sizeBytes: 3,
                mimeType: "image/png",
              }}
              alt={`Caption ${id}`}
              imageProps={{
                id: `image-${id}`,
                title: "Authored title",
                className: "authored-class",
              }}
              copyMarkdown={`![Caption ${id}](${id}.png)`}
              width={320}
              height={160}
            />
          ))}
        </div>,
      ),
    );
    await act(async () => {
      for (const img of host.querySelectorAll("img")) img.dispatchEvent(new Event("load"));
    });
    const first = host.querySelector<HTMLImageElement>('img[alt="Caption first"]')!;
    expect(first.closest("[data-image-preview]")?.id).toBe("image-first");
    expect(host.querySelectorAll("#image-first")).toHaveLength(1);
    expect(first.title).toBe("Authored title");
    expect(first.classList.contains("authored-class")).toBe(true);
    expect(first.dataset.markdownCopy).toBe("![Caption first](first.png)");
    expect(first.style.width).toBe("320px");
    expect(first.style.aspectRatio).toBe("320 / 160");
    await act(async () => first.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe(
      "Caption first",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe(
      "Caption second",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it("offers retry with the authored alt text when loading fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.failed = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CapturedMarkdownImage
          environmentId={EnvironmentId.make("env")}
          artifact={{
            id: ScreenshotArtifactId.make("one"),
            name: "one.png",
            mimeType: "image/png",
            sizeBytes: 3,
          }}
          alt="Result chart"
        />,
      ),
    );
    expect(host.textContent).toContain("Image unavailable · Result chart");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
it("uses upstream aspect-ratio sizing and ignores invalid dimensions", () => {
  expect(authoredImageSizeStyle(400, 800)).toMatchObject({
    width: 400,
    height: "auto",
    aspectRatio: "400 / 800",
  });
  expect(authoredImageSizeStyle(-1, "invalid")).toBeUndefined();
});

it("keeps a captured gallery open while retry refreshes its transport URL", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const artifact = {
    id: ScreenshotArtifactId.make("retry"),
    name: "retry.png",
    mimeType: "image/png" as const,
    sizeBytes: 3,
  };
  const render = () =>
    act(async () =>
      root.render(
        <CapturedImageDialog
          environmentId={EnvironmentId.make("env")}
          onClose={onClose}
          preview={{ index: 0, images: [{ src: null, name: "Retry", artifact }] }}
        />,
      ),
    );
  try {
    mocks.failed = true;
    await render();
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry image")!
        .click(),
    );
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    mocks.failed = false;
    await render();
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("blob:retry");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps a deferred screenshot's dimensions and opens it with the keyboard", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.deferred = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CapturedMarkdownImage
          environmentId={EnvironmentId.make("env")}
          artifact={{
            id: ScreenshotArtifactId.make("one"),
            name: "one.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dimensions: { width: 400, height: 200 },
          }}
          alt="Result chart"
        />,
      ),
    );
    const placeholder = host.querySelector<HTMLElement>('[role="button"]')!;
    expect(placeholder.textContent).toContain("Open image");
    expect(placeholder.style.aspectRatio).toBe("400 / 200");
    await act(async () =>
      placeholder.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves gallery selection through insertion, reordering, and removal of turn images", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const environmentId = EnvironmentId.make("env");
  const turn = TurnId.make("turn");
  const references = ["a", "b", "c", "d"].map((id) => ({
    id: ScreenshotArtifactId.make(id),
    name: id,
    mimeType: "image/png" as const,
    sizeBytes: 3,
  }));
  const render = (ids: string[]) => {
    const artifacts = ids.map((id) => references.find((image) => image.id === id)!);
    return act(async () =>
      root.render(
        <ArtifactNavigationContext
          value={{
            environmentId,
            artifactsByTurn: new Map([[turn, artifacts]]),
            request: null,
            reveal: () => {},
          }}
        >
          <ArtifactTurnContext value={turn}>
            <CapturedImageDialog
              environmentId={environmentId}
              onClose={() => {}}
              preview={{
                index: artifacts.findIndex((image) => image.id === "b"),
                images: artifacts.map((artifact) => ({ artifact, name: artifact.name, src: null })),
              }}
            />
          </ArtifactTurnContext>
        </ArtifactNavigationContext>,
      ),
    );
  };
  const selected = () => document.querySelector('[role="dialog"] img')?.getAttribute("src");
  const next = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
  try {
    await render(["a", "b", "c"]);
    expect(selected()).toBe("blob:b");
    await render(["b", "c"]);
    expect(selected()).toBe("blob:b");
    await next();
    expect(selected()).toBe("blob:c");
    await render(["d", "a", "b", "c"]);
    expect(selected()).toBe("blob:c");
    await render(["c", "b", "d"]);
    expect(selected()).toBe("blob:c");
    await render(["d", "b"]);
    expect(selected()).toBe("blob:d");
    await render(["c", "d", "b"]);
    expect(selected()).toBe("blob:d");
    await next();
    expect(selected()).toBe("blob:b");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps one stable Markdown anchor through offscreen, loaded, deferred, and failed states", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let observerCallback: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <CapturedMarkdownImage
          environmentId={EnvironmentId.make("env")}
          artifact={{
            id: ScreenshotArtifactId.make("figure"),
            name: "figure.png",
            mimeType: "image/png",
            sizeBytes: 3,
          }}
          alt="Figure"
          imageProps={{
            id: "user-content-figure",
            title: "Figure title",
            className: "authored-class",
          }}
          copyMarkdown="![Figure](figure.png)"
        />,
      ),
    );
  const setVisible = (isIntersecting: boolean) =>
    act(async () =>
      observerCallback!(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
  try {
    await render();
    const anchor = host.querySelector("#user-content-figure");
    expect(anchor).not.toBeNull();
    const expectAnchor = () => {
      expect(host.querySelectorAll("#user-content-figure")).toHaveLength(1);
      expect(host.querySelector("#user-content-figure")).toBe(anchor);
    };
    const placeholder = host.querySelector<HTMLElement>('[role="button"]')!;
    expect(placeholder.title).toBe("Figure title");
    expect(placeholder.classList.contains("authored-class")).toBe(true);
    expect(placeholder.dataset.markdownCopy).toBe("![Figure](figure.png)");
    await setVisible(true);
    await act(async () => host.querySelector("img")!.dispatchEvent(new Event("load")));
    expectAnchor();
    await setVisible(false);
    expectAnchor();
    mocks.deferred = true;
    await setVisible(true);
    expect(host.textContent).toContain("Open image");
    expectAnchor();
    mocks.deferred = false;
    mocks.failed = true;
    await render();
    expect(host.textContent).toContain("Image unavailable");
    expectAnchor();
  } finally {
    await act(async () => root.unmount());
  }
});
