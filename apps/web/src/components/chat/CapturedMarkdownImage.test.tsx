// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ScreenshotArtifactId, TurnId } from "@t3tools/contracts";
import { CapturedImageDialog } from "./CapturedMarkdownImage";
import { ArtifactNavigationContext, ArtifactTurnContext } from "./ArtifactNavigation";
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
      document.querySelector<HTMLButtonElement>('[aria-label="Next media"]')!.click(),
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
