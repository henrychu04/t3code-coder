// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useConnectDiscoveredWorkspace } from "./useConnectDiscoveredWorkspace";
import type { CoderProfileConfig, DiscoveredCoderWorkspace } from "./api";
const state = vi.hoisted(() => ({
  config: { version: 1, deployments: [], workspaces: [] } as CoderProfileConfig,
  saveConfig: vi.fn(),
  connectWorkspace: vi.fn(),
  start: vi.fn(),
}));
vi.mock("./CoderBootstrap", () => ({ useCoder: () => state }));
vi.mock("./api", () => ({ startCoderWorkspace: state.start }));
let root: Root;
let connect: ReturnType<typeof useConnectDiscoveredWorkspace>;
function Consumer() {
  connect = useConnectDiscoveredWorkspace();
  return null;
}
const workspace = {
  target: "owner/workspace",
  name: "Workspace",
  status: "stopped",
  updateAvailable: false,
  healthy: true,
  autostopAt: null,
  requiredStopAt: null,
} satisfies DiscoveredCoderWorkspace;
beforeEach(async () => {
  vi.resetAllMocks();
  state.config = { version: 1, deployments: [], workspaces: [] };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Consumer />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("saves a new profile before starting and connecting", async () => {
  const order: string[] = [];
  state.saveConfig.mockImplementation(async () => {
    order.push("save");
  });
  state.start.mockImplementation(async () => {
    order.push("start");
  });
  state.connectWorkspace.mockImplementation(async () => {
    order.push("connect");
    return "descriptor";
  });
  expect(await connect("deployment", workspace)).toBe("descriptor");
  expect(order).toEqual(["save", "start", "connect"]);
  const profile = state.saveConfig.mock.calls[0]![0].workspaces[0];
  expect(profile).toMatchObject({ deploymentId: "deployment", workspace: workspace.target });
  expect(state.start).toHaveBeenCalledWith(profile.id);
  expect(state.connectWorkspace).toHaveBeenCalledWith(profile.id);
});
it("reuses a running profile without saving or starting it", async () => {
  state.config = {
    ...state.config,
    workspaces: [
      {
        id: "existing",
        name: "Workspace",
        deploymentId: "deployment",
        workspace: workspace.target,
      },
    ],
  };
  await act(async () => root.render(<Consumer />));
  await connect("deployment", { ...workspace, status: "running" });
  expect(state.saveConfig).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  expect(state.connectWorkspace).toHaveBeenCalledWith("existing");
});
it("does not start or connect if saving fails", async () => {
  state.saveConfig.mockRejectedValue(new Error("Save failed"));
  await expect(connect("deployment", workspace)).rejects.toThrow("Save failed");
  expect(state.start).not.toHaveBeenCalled();
  expect(state.connectWorkspace).not.toHaveBeenCalled();
});
