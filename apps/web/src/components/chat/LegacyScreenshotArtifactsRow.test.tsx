// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";

import { LegacyScreenshotArtifactsRow } from "./LegacyScreenshotArtifactsRow";

const mocks = vi.hoisted(() => ({
  connected: [] as string[],
  queried: [] as unknown[],
  artifacts: [] as unknown[],
}));
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => mocks.connected,
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    listLegacyScreenshotArtifacts: (target: unknown) => target,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.queried.push(atom);
    return { data: atom === null ? null : { artifacts: mocks.artifacts } };
  },
}));
vi.mock("./ScreenshotArtifactsRow", () => ({
  ScreenshotArtifactsRow: ({ artifacts }: { artifacts: { name: string }[] }) => (
    <span data-testid="row">{artifacts.map((artifact) => artifact.name).join(",")}</span>
  ),
}));

afterEach(() => {
  mocks.connected = [];
  mocks.queried = [];
  mocks.artifacts = [];
  vi.unstubAllGlobals();
});

const environmentId = EnvironmentId.make("env");
const render = async (runId: RunId | null) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <LegacyScreenshotArtifactsRow
        environmentId={environmentId}
        message={{ id: MessageId.make("message"), runId }}
      />,
    );
  });
  const text = host.textContent;
  await act(async () => root.unmount());
  return text;
};

it("looks up only imported messages once the workspace is connected", async () => {
  mocks.artifacts = [{ name: "shot.png" }];
  expect(await render(null)).toBe("");
  expect(mocks.queried).toEqual([null]);

  mocks.connected = ["env"];
  mocks.queried = [];
  expect(await render(RunId.make("run"))).toBe("");
  expect(mocks.queried).toEqual([null]);

  mocks.queried = [];
  expect(await render(null)).toBe("shot.png");
  expect(mocks.queried).toEqual([{ environmentId, input: { messageId: "message" } }]);
});

it("renders nothing when the message has no legacy screenshots", async () => {
  mocks.connected = ["env"];
  expect(await render(null)).toBe("");
});
