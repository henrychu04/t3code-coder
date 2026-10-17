import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: [] as string[],
  calls: [] as Array<{ expanded: boolean }>,
}));

vi.mock("../state/environments", () => ({
  useConnectedEnvironmentIds: () => state.connected,
}));
vi.mock("../components/chat/useScreenshotArtifacts", () => ({
  useScreenshotArtifacts: (
    _environmentId: string,
    artifacts: ReadonlyArray<{ id: string }>,
    expanded: boolean,
  ) => {
    state.calls.push({ expanded });
    return expanded
      ? Object.fromEntries(
          artifacts.map((artifact) => [
            artifact.id,
            { status: "loaded", url: `blob:${artifact.id}`, retry: () => {} },
          ]),
        )
      : {};
  },
}));

import { useAssetUrls } from "./assetUrls";

const environmentId = EnvironmentId.make("env");
const resources = [
  { _tag: "attachment" as const, attachmentId: "image", mimeType: "image/png" as const },
];

describe("useAssetUrls", () => {
  beforeEach(() => {
    state.connected = [];
    state.calls = [];
  });

  it("waits for the workspace connection before reading submitted images", () => {
    expect(useAssetUrls(environmentId, resources)).toEqual([null]);
    expect(state.calls).toEqual([{ expanded: false }]);

    state.connected = ["env"];
    expect(useAssetUrls(environmentId, resources)).toEqual(["blob:image"]);
    expect(state.calls.at(-1)).toEqual({ expanded: true });
  });
});
