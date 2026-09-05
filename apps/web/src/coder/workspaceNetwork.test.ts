import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  removeCoderWorkspaceEnvironment,
  setCoderWorkspaceEnvironment,
} from "./environmentStore";
import {
  FAST_PROBE_INTERVAL_MS,
  NOMINAL_PROBE_INTERVAL_MS,
  nextCoderProbeIntervalMs,
  readCoderWorkspaceNetwork,
  startCoderWorkspaceNetworkSampler,
  stopCoderWorkspaceNetworkSamplerForTests,
} from "./workspaceNetwork";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

const descriptor = (environmentId: string): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label: "Workspace One",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0.0",
  capabilities: { repositoryIdentity: false },
});

afterEach(() => {
  removeCoderWorkspaceEnvironment("workspace-one");
  stopCoderWorkspaceNetworkSamplerForTests();
  vi.useRealTimers();
});

describe("Coder workspace network probe cadence", () => {
  it("probes every second while recovering and every five seconds when nominal", () => {
    expect(nextCoderProbeIntervalMs(0)).toBe(NOMINAL_PROBE_INTERVAL_MS);
    expect(nextCoderProbeIntervalMs(1)).toBe(FAST_PROBE_INTERVAL_MS);
    expect(nextCoderProbeIntervalMs(2)).toBe(FAST_PROBE_INTERVAL_MS);
  });

  it("publishes a fresh sample and accelerates after consecutive slow samples", async () => {
    vi.useFakeTimers();
    setCoderWorkspaceEnvironment("workspace-one", descriptor("environment-one"));
    let call = 0;
    const latencies = [10, 300, 320, 12];
    startCoderWorkspaceNetworkSampler({
      probe: async () => latencies[Math.min(call++, latencies.length - 1)] ?? null,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({
      latencyMs: 10,
      stale: false,
      slow: false,
    });

    await vi.advanceTimersByTimeAsync(NOMINAL_PROBE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FAST_PROBE_INTERVAL_MS);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({
      latencyMs: 320,
      stale: false,
      slow: true,
    });

    await vi.advanceTimersByTimeAsync(FAST_PROBE_INTERVAL_MS);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({
      latencyMs: 12,
      stale: false,
      slow: false,
    });
  });

  it("keeps the last sample and marks it stale when probes stop succeeding", async () => {
    vi.useFakeTimers();
    setCoderWorkspaceEnvironment("workspace-one", descriptor("environment-one"));
    let fail = false;
    startCoderWorkspaceNetworkSampler({
      probe: async () => (fail ? null : 8),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({
      latencyMs: 8,
      stale: false,
    });

    fail = true;
    await vi.advanceTimersByTimeAsync(NOMINAL_PROBE_INTERVAL_MS);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({
      latencyMs: 8,
      stale: true,
    });
  });

  it("drops the sample when the workspace disconnects", async () => {
    vi.useFakeTimers();
    setCoderWorkspaceEnvironment("workspace-one", descriptor("environment-one"));
    startCoderWorkspaceNetworkSampler({ probe: async () => 9 });

    await vi.advanceTimersByTimeAsync(0);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toBeDefined();

    removeCoderWorkspaceEnvironment("workspace-one");
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toBeUndefined();
  });

  it("starts only one sampler for repeated calls", async () => {
    vi.useFakeTimers();
    setCoderWorkspaceEnvironment("workspace-one", descriptor("environment-one"));
    const probe = vi.fn(async () => 5);
    startCoderWorkspaceNetworkSampler({ probe });
    startCoderWorkspaceNetworkSampler({ probe: async () => 999 });

    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readCoderWorkspaceNetwork()["workspace-one"]).toMatchObject({ latencyMs: 5 });
  });
});
