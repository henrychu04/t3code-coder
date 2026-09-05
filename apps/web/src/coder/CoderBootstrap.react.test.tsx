// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { CoderBootstrap, useCoder } from "./CoderBootstrap";
import * as api from "./api";
import { readCoderWorkspaceEnvironments, setCoderWorkspaceOrder } from "./environmentStore";

vi.mock("./api", () => ({
  loadCoderConfig: vi.fn(),
  saveCoderConfig: vi.fn(),
  discoverCoderWorkspaces: vi.fn(),
  connectCoderWorkspace: vi.fn(),
  disconnectCoderWorkspace: vi.fn(),
  startCoderWorkspace: vi.fn(),
  stopCoderWorkspace: vi.fn(),
  restartCoderWorkspace: vi.fn(),
  updateCoderWorkspace: vi.fn(),
}));
vi.mock("./workspaceNetwork", () => {
  const state = {};
  return {
    readCoderWorkspaceNetwork: () => state,
    subscribeCoderWorkspaceNetwork: () => () => {},
    startCoderWorkspaceNetworkSampler: () => {},
  };
});

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useCoder>;
function Consumer() {
  current = useCoder();
  return null;
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const running = [
  {
    target: "owner/workspace",
    name: "workspace",
    status: "running",
    updateAvailable: false,
    healthy: true,
    autostopAt: null,
    requiredStopAt: null,
  },
];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  setCoderWorkspaceOrder([]);
  vi.mocked(api.loadCoderConfig).mockResolvedValue({
    version: 1,
    deployments: [{ id: "d", name: "Coder", url: "https://coder.example" }],
    workspaces: [{ id: "w", name: "Workspace", deploymentId: "d", workspace: "owner/workspace" }],
  });
  vi.mocked(api.discoverCoderWorkspaces).mockResolvedValue(
    running as Awaited<ReturnType<typeof api.discoverCoderWorkspaces>>,
  );
  vi.mocked(api.connectCoderWorkspace).mockResolvedValue({
    environmentId: EnvironmentId.make("env"),
  } as ExecutionEnvironmentDescriptor);
  vi.mocked(api.stopCoderWorkspace).mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CoderBootstrap app={<Consumer />} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setCoderWorkspaceOrder([]);
  vi.unstubAllGlobals();
});

it("ignores discovery that started before a completed stop", async () => {
  const discovery = deferred<Awaited<ReturnType<typeof api.discoverCoderWorkspaces>>>();
  vi.mocked(api.discoverCoderWorkspaces).mockReturnValueOnce(discovery.promise);
  let refresh!: ReturnType<typeof current.refreshWorkspaceRuntime>;
  await act(async () => {
    refresh = current.refreshWorkspaceRuntime();
  });
  await act(async () => {
    await current.stopWorkspace("w");
  });
  await act(async () => {
    discovery.resolve(running as Awaited<ReturnType<typeof api.discoverCoderWorkspaces>>);
    await refresh;
  });
  expect(current.workspaceRuntime.w?.status).toBe("stopped");
  expect(readCoderWorkspaceEnvironments()).toEqual([]);
});

it("does not reconnect when an older start completes after a stop", async () => {
  const start = deferred<void>();
  vi.mocked(api.startCoderWorkspace).mockReturnValueOnce(start.promise);
  let starting!: Promise<unknown>;
  await act(async () => {
    starting = current.startWorkspace("w").catch((error) => error);
  });
  await act(async () => {
    await current.stopWorkspace("w");
  });
  let result: unknown;
  await act(async () => {
    start.resolve();
    result = await starting;
  });
  expect(result).toBeInstanceOf(Error);
  expect(api.connectCoderWorkspace).toHaveBeenCalledTimes(1);
  expect(readCoderWorkspaceEnvironments()).toEqual([]);
  expect(current.workspaceRuntime.w?.status).toBe("stopped");
});

it("does not restore a removed workspace when an old connection completes", async () => {
  const connection = deferred<ExecutionEnvironmentDescriptor>();
  vi.mocked(api.connectCoderWorkspace).mockReturnValueOnce(connection.promise);
  let connecting!: Promise<ExecutionEnvironmentDescriptor>;
  await act(async () => {
    connecting = current.connectWorkspace("w");
  });
  const emptyConfig = { ...current.config, workspaces: [] };
  vi.mocked(api.saveCoderConfig).mockResolvedValueOnce(emptyConfig);
  await act(async () => {
    await current.saveConfig(emptyConfig);
  });
  await act(async () => {
    connection.resolve({
      environmentId: EnvironmentId.make("old"),
    } as ExecutionEnvironmentDescriptor);
    await connecting;
  });
  expect(readCoderWorkspaceEnvironments()).toEqual([]);
  expect(current.workspaceRuntime).toEqual({});
});

it("refreshes actual status after a failed start", async () => {
  vi.mocked(api.startCoderWorkspace).mockRejectedValueOnce(new Error("Start failed"));
  vi.mocked(api.discoverCoderWorkspaces).mockResolvedValue([
    { ...running[0], status: "stopped" },
  ] as Awaited<ReturnType<typeof api.discoverCoderWorkspaces>>);
  await act(async () => {
    await current.startWorkspace("w").catch(() => undefined);
  });
  expect(current.workspaceRuntime.w?.status).toBe("stopped");
});

it("refreshes actual status after a failed stop", async () => {
  vi.mocked(api.stopCoderWorkspace).mockRejectedValueOnce(new Error("Stop failed"));
  vi.mocked(api.discoverCoderWorkspaces).mockResolvedValue([
    { ...running[0], status: "stopped" },
  ] as Awaited<ReturnType<typeof api.discoverCoderWorkspaces>>);
  await act(async () => {
    await current.stopWorkspace("w").catch(() => undefined);
  });
  expect(current.workspaceRuntime.w?.status).toBe("stopped");
});
