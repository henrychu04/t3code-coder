// @vitest-environment happy-dom
import ChatMarkdown from "../ChatMarkdown";
import { createHash, webcrypto } from "node:crypto";
import { EnvironmentId, ScreenshotArtifactId, TurnId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ArtifactNavigationContext,
  ArtifactTurnContext,
  findLinkedArtifact,
} from "./ArtifactNavigation";
const load = vi.hoisted(() =>
  vi.fn((_environmentId: unknown, _artifacts: unknown, _expanded: boolean) => ({})),
);
vi.mock("./useScreenshotArtifacts", () => ({ useScreenshotArtifacts: load }));
const artifact = {
  id: ScreenshotArtifactId.make("artifact"),
  name: "shot.png",
  mimeType: "image/png" as const,
  sizeBytes: 8,
  sourcePathKeys: [createHash("sha256").update("artifact\0screens/shot.png").digest("hex")],
};
afterEach(() => vi.unstubAllGlobals());
it("matches exact captured paths, never basenames, traversal, or legacy metadata", async () => {
  vi.stubGlobal("crypto", webcrypto);
  expect(await findLinkedArtifact("screens/shot.png", [artifact])).toBe(artifact);
  for (const path of [
    "shot.png",
    "other/shot.png",
    "../screens/shot.png",
    "/screens/shot.png",
    "screens/./shot.png",
  ]) {
    expect(await findLinkedArtifact(path, [artifact])).toBeUndefined();
  }
  expect(
    await findLinkedArtifact("screens/shot.png", [{ ...artifact, sourcePathKeys: [] }]),
  ).toBeUndefined();
});
it("renders captured Markdown images inline and opens links directly in the gallery", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const turn = TurnId.make("turn");
  const reveal = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ArtifactNavigationContext
          value={{
            environmentId: EnvironmentId.make("env"),
            artifactsByTurn: new Map([[turn, [artifact]]]),
            reveal,
            request: null,
          }}
        >
          <ArtifactTurnContext value={turn}>
            <ChatMarkdown
              cwd="/project"
              text="![Screenshot](screens/shot.png) [Open image](screens/shot.png)"
            />
          </ArtifactTurnContext>
        </ArtifactNavigationContext>,
      ),
    );
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Loading image"]')).not.toBeNull(),
    );
    expect(load.mock.calls.at(-1)?.[2]).toBe(true);
    await act(async () =>
      host.querySelector<HTMLAnchorElement>('a[title="Preview image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(reveal).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([
  "[![shot](screens/shot.png)](screens/shot.png)",
  "[`screens/shot.png`](screens/shot.png)",
])("renders one action for nested image references: %s", async (text) => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const turn = TurnId.make("turn");
  const reveal = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ArtifactNavigationContext
          value={{ artifactsByTurn: new Map([[turn, [artifact]]]), reveal, request: null }}
        >
          <ArtifactTurnContext value={turn}>
            <ChatMarkdown cwd="/project" text={text} />
          </ArtifactTurnContext>
        </ArtifactNavigationContext>,
      ),
    );
    await vi.waitFor(() =>
      expect(host.querySelectorAll('a[title="Preview image"]')).toHaveLength(1),
    );
    expect(host.querySelector("a a")).toBeNull();
    await act(async () =>
      host.querySelector<HTMLAnchorElement>('a[title="Preview image"]')!.click(),
    );
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(artifact.id);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps linked captured images visible and browses neighboring images", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  load.mockReturnValue({ artifact: { status: "loaded", url: "blob:artifact", retry: vi.fn() } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const turn = TurnId.make("turn");
  try {
    await act(async () =>
      root.render(
        <ArtifactNavigationContext
          value={{
            environmentId: EnvironmentId.make("env"),
            artifactsByTurn: new Map([[turn, [artifact]]]),
            reveal: vi.fn(),
            request: null,
          }}
        >
          <ArtifactTurnContext value={turn}>
            <ChatMarkdown
              cwd="/project"
              text={
                '[![Linked](screens/shot.png "Figure title")](screens/shot.png) ![Neighbor](screens/shot.png)'
              }
            />
          </ArtifactTurnContext>
        </ArtifactNavigationContext>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.querySelectorAll("img")).toHaveLength(2);
    });
    await act(async () => {
      for (const image of host.querySelectorAll("img")) image.dispatchEvent(new Event("load"));
    });
    expect(host.querySelector('img[alt="Linked"]')?.getAttribute("title")).toBe("Figure title");
    expect(host.querySelector('img[alt="Linked"]')?.getAttribute("data-markdown-copy")).toBe(
      '![Linked](screens/shot.png "Figure title")',
    );
    await act(async () => host.querySelector<HTMLImageElement>('img[alt="Linked"]')!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("Neighbor");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    load.mockReturnValue({});
  }
});

it("selects the latest view of a path when old bytes are later reused for another file", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const reference = (id: string, path: string) => ({
    ...artifact,
    id: ScreenshotArtifactId.make(id),
    sourcePathKeys: [createHash("sha256").update(`${id}\0${path}`).digest("hex")],
  });
  const redA = reference("red", "a.png");
  const blueA = reference("blue", "a.png");
  const redB = reference("red", "b.png");
  expect(await findLinkedArtifact("a.png", [redA, blueA, redB])).toBe(blueA);
  expect(await findLinkedArtifact("b.png", [redA, blueA, redB])).toBe(redB);
});
