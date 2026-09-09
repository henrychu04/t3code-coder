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
  createArtifactNavigationRequest,
} from "./ArtifactNavigation";
import { ScreenshotArtifactsRow } from "./ScreenshotArtifactsRow";
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
it("reveals the captured thumbnail on click without opening the lightbox, scoped to the turn", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const turn = TurnId.make("turn");
  const reveal = vi.fn();
  const artifacts = [artifact];
  const artifactsByTurn = new Map([[turn, artifacts]]);
  const render = (sequence: number, activeTurn = turn, requestedId: string = artifact.id) =>
    root.render(
      <ArtifactNavigationContext
        value={{
          artifactsByTurn,
          reveal,
          request: sequence ? createArtifactNavigationRequest(requestedId) : null,
        }}
      >
        <ArtifactTurnContext value={activeTurn}>
          <ChatMarkdown cwd="/project" text="[Image link](file:///project/screens/shot.png)" />
        </ArtifactTurnContext>
        <ScreenshotArtifactsRow artifacts={artifacts} environmentId={EnvironmentId.make("env")} />
      </ArtifactNavigationContext>,
    );
  try {
    await act(async () => {
      render(0);
    });
    // The browser digest resolves outside React's initial effect flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const link = host.querySelector<HTMLButtonElement>('button[title="Show in Visual artifacts"]');
    expect(link).not.toBeNull();
    expect(load.mock.calls.at(-1)?.[2]).toBe(false);
    await act(async () => link!.click());
    expect(reveal).toHaveBeenCalledWith(artifact.id);
    await act(async () => render(1));
    expect(host.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(host.querySelector('[data-highlighted="true"]')?.getAttribute("data-artifact-id")).toBe(
      artifact.id,
    );
    expect(load.mock.calls.at(-1)?.[2]).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const thumbnail = host.querySelector<HTMLElement>("[data-artifact-id]")!;
    const scroll = vi.fn();
    thumbnail.scrollIntoView = scroll;
    await act(async () => render(2, turn, "another-gallery-image"));
    expect(scroll).not.toHaveBeenCalled();
    expect(host.querySelector('[data-highlighted="true"]')).toBeNull();
    await act(async () => render(1, TurnId.make("other-turn")));
    expect(host.querySelector('button[title="Show in Visual artifacts"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("does not replay consumed requests after a gallery remount, but accepts a fresh click", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const reader = document.createElement("button");
  document.body.append(host, reader);
  const root = createRoot(host);
  const artifacts = [artifact];
  const request = createArtifactNavigationRequest(artifact.id);
  const render = (nextRequest = request) =>
    root.render(
      <ArtifactNavigationContext
        value={{ artifactsByTurn: new Map(), reveal: vi.fn(), request: nextRequest }}
      >
        <ScreenshotArtifactsRow artifacts={artifacts} environmentId={EnvironmentId.make("env")} />
      </ArtifactNavigationContext>,
    );
  try {
    await act(async () => render());
    expect(document.activeElement?.getAttribute("data-artifact-id")).toBe(artifact.id);
    await act(async () => root.render(null));
    reader.focus();
    await act(async () => render());
    expect(document.activeElement).toBe(reader);
    expect(host.querySelector('[aria-expanded="false"]')).not.toBeNull();
    expect(load.mock.calls.at(-1)?.[2]).toBe(false);
    await act(async () => render(createArtifactNavigationRequest(artifact.id)));
    expect(document.activeElement?.getAttribute("data-artifact-id")).toBe(artifact.id);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    reader.remove();
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
    await vi.waitFor(() => expect(host.querySelectorAll("button")).toHaveLength(1));
    expect(host.querySelector("button button")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(artifact.id);
  } finally {
    await act(async () => root.unmount());
  }
});
