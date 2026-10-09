import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: [] as string[],
  run: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({ run: state.run }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => state.connected },
}));

import { removeCoderWorkspaceEnvironment, setCoderWorkspaceEnvironment } from "./environmentStore";
import {
  NOMINAL_PROBE_INTERVAL_MS,
  readCoderWorkspaceNetwork,
  startCoderWorkspaceNetworkSampler,
  stopCoderWorkspaceNetworkSamplerForTests,
} from "./workspaceNetwork";

const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-one"),
  label: "Workspace One",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0.0",
  capabilities: { repositoryIdentity: false },
};

afterEach(() => {
  removeCoderWorkspaceEnvironment("workspace-one");
  stopCoderWorkspaceNetworkSamplerForTests();
  state.connected = [];
  state.run.mockReset();
  vi.useRealTimers();
});

describe("Coder workspace network default probe", () => {
  it("does not probe a workspace until its environment is connected", async () => {
    vi.useFakeTimers();
    state.run.mockResolvedValue(AsyncResult.success({}));
    setCoderWorkspaceEnvironment("workspace-one", descriptor);
    startCoderWorkspaceNetworkSampler();

    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).not.toHaveBeenCalled();
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toBeUndefined();

    state.connected = ["environment-one"];
    await vi.advanceTimersByTimeAsync(NOMINAL_PROBE_INTERVAL_MS);
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toBeDefined();
  });
});
