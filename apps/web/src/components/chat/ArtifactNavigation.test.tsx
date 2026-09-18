// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { EnvironmentId, ScreenshotArtifactId, TurnId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ArtifactNavigationContext,
  ArtifactTurnContext,
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
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => vi.unstubAllGlobals());
it("opens images from separate tool activities in one deduplicated turn gallery", async () => {
  const { ScreenshotArtifactsRow } = await import("./ScreenshotArtifactsRow");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const neighbor = { ...artifact, id: ScreenshotArtifactId.make("second"), name: "second.png" };
  load.mockReturnValue({
    artifact: { status: "loaded", url: "blob:artifact", retry: vi.fn() },
    second: { status: "loaded", url: "blob:second", retry: vi.fn() },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const turn = TurnId.make("turn");
  const environmentId = EnvironmentId.make("env");
  try {
    await act(async () =>
      root.render(
        <ArtifactNavigationContext
          value={{
            environmentId,
            artifactsByTurn: new Map([[turn, [artifact, neighbor, artifact]]]),
            reveal: vi.fn(),
            request: null,
          }}
        >
          <ArtifactTurnContext value={turn}>
            <ScreenshotArtifactsRow environmentId={environmentId} artifacts={[artifact]} />
            <ScreenshotArtifactsRow environmentId={environmentId} artifacts={[neighbor]} />
          </ArtifactTurnContext>
        </ArtifactNavigationContext>,
      ),
    );
    expect(host.textContent).toContain("Images in this turn · 2");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Preview shot.png"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("shot.png");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("second.png");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("(2/2)");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("shot.png");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    load.mockReturnValue({});
  }
});
