import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: [] as string[],
  calls: [] as Array<{ resources: number }>,
}));

vi.mock("../state/environments", () => ({
  useConnectedEnvironmentIds: () => state.connected,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: <A>(atom: A) => atom }));
vi.mock("../state/assets", () => ({
  assetEnvironment: {
    createUrls: (target: { resources: ReadonlyArray<{ attachmentId: string }> }) => {
      state.calls.push({ resources: target.resources.length });
      return target.resources.map((resource) => ({
        status: "loaded",
        url: `blob:${resource.attachmentId}`,
        retry: () => {},
      }));
    },
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
    expect(state.calls).toEqual([{ resources: 0 }]);

    state.connected = ["env"];
    expect(useAssetUrls(environmentId, resources)).toEqual(["blob:image"]);
    expect(state.calls.at(-1)).toEqual({ resources: 1 });
  });
});
