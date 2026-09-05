import { type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readCoderWorkspaceEnvironments,
  subscribeCoderWorkspaceEnvironments,
} from "./environmentStore";

export interface CoderWorkspaceNetworkSample {
  readonly latencyMs: number;
  readonly sampledAt: number;
}

export interface CoderWorkspaceNetworkState extends CoderWorkspaceNetworkSample {
  readonly stale: boolean;
  readonly slow: boolean;
}

export const SLOW_NETWORK_LATENCY_MS = 250;
const STALE_NETWORK_SAMPLE_MS = 5_000;
export const FAST_PROBE_INTERVAL_MS = 1_000;
export const NOMINAL_PROBE_INTERVAL_MS = 5_000;

export function nextCoderSlowSampleCount(current: number, latencyMs: number): number {
  return latencyMs >= SLOW_NETWORK_LATENCY_MS ? Math.min(2, current + 1) : Math.max(0, current - 1);
}

export function nextCoderProbeIntervalMs(slowCount: number): number {
  return slowCount > 0 ? FAST_PROBE_INTERVAL_MS : NOMINAL_PROBE_INTERVAL_MS;
}

const probeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "coder-workspace-probe",
  tag: "server.probe",
});

type WorkspaceNetworkProbe = (environmentId: EnvironmentId) => Promise<number | null>;

const defaultProbe: WorkspaceNetworkProbe = async (environmentId) => {
  const startedAt = performance.now();
  try {
    const result = await probeCommand.run(appAtomRegistry, { environmentId, input: {} });
    return AsyncResult.isSuccess(result) ? performance.now() - startedAt : null;
  } catch {
    return null;
  }
};

interface WorkspaceSampler {
  readonly workspaceId: string;
  environmentId: EnvironmentId;
  sample: CoderWorkspaceNetworkSample | null;
  stale: boolean;
  slowCount: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

let network: Readonly<Record<string, CoderWorkspaceNetworkState>> = {};
const listeners = new Set<() => void>();
const samplers = new Map<string, WorkspaceSampler>();
let probe: WorkspaceNetworkProbe = defaultProbe;
let started = false;
let unsubscribeEnvironments: (() => void) | null = null;
let visibilityListener: (() => void) | null = null;

export function readCoderWorkspaceNetwork(): Readonly<Record<string, CoderWorkspaceNetworkState>> {
  return network;
}

export function subscribeCoderWorkspaceNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(): void {
  for (const listener of listeners) listener();
}

function applySample(sampler: WorkspaceSampler, latencyMs: number | null): void {
  if (samplers.get(sampler.workspaceId) !== sampler) return;
  if (latencyMs !== null) {
    sampler.slowCount = nextCoderSlowSampleCount(sampler.slowCount, latencyMs);
    sampler.sample = { latencyMs, sampledAt: Date.now() };
    sampler.stale = false;
  } else if (
    sampler.sample !== null &&
    !sampler.stale &&
    Date.now() - sampler.sample.sampledAt >= STALE_NETWORK_SAMPLE_MS
  ) {
    sampler.stale = true;
  } else {
    return;
  }
  network = currentNetworkState();
  publish();
}

function currentNetworkState(): Readonly<Record<string, CoderWorkspaceNetworkState>> {
  const next: Record<string, CoderWorkspaceNetworkState> = {};
  for (const sampler of samplers.values()) {
    if (sampler.sample === null) continue;
    next[sampler.workspaceId] = {
      ...sampler.sample,
      stale: sampler.stale,
      slow: sampler.slowCount >= 2,
    };
  }
  return next;
}

function scheduleProbe(sampler: WorkspaceSampler): void {
  if (sampler.timer !== undefined) clearTimeout(sampler.timer);
  sampler.timer = setTimeout(() => {
    sampler.timer = undefined;
    void runProbe(sampler);
  }, nextCoderProbeIntervalMs(sampler.slowCount));
}

async function runProbe(sampler: WorkspaceSampler): Promise<void> {
  if (sampler.inFlight) {
    scheduleProbe(sampler);
    return;
  }
  if (typeof document !== "undefined" && document.hidden) {
    scheduleProbe(sampler);
    return;
  }
  sampler.inFlight = true;
  const latencyMs = await probe(sampler.environmentId).catch(() => null);
  sampler.inFlight = false;
  applySample(sampler, latencyMs);
  if (samplers.get(sampler.workspaceId) === sampler) scheduleProbe(sampler);
}

function syncSamplers(): void {
  const seen = new Set<string>();
  for (const entry of readCoderWorkspaceEnvironments()) {
    seen.add(entry.workspaceId);
    const existing = samplers.get(entry.workspaceId);
    if (existing !== undefined) {
      existing.environmentId = entry.descriptor.environmentId;
      continue;
    }
    const sampler: WorkspaceSampler = {
      workspaceId: entry.workspaceId,
      environmentId: entry.descriptor.environmentId,
      sample: null,
      stale: false,
      slowCount: 0,
      inFlight: false,
      timer: undefined,
    };
    samplers.set(entry.workspaceId, sampler);
    void runProbe(sampler);
  }
  for (const [workspaceId, sampler] of samplers) {
    if (seen.has(workspaceId)) continue;
    if (sampler.timer !== undefined) clearTimeout(sampler.timer);
    samplers.delete(workspaceId);
  }
  network = currentNetworkState();
  publish();
}

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const sampler of samplers.values()) void runProbe(sampler);
}

export function startCoderWorkspaceNetworkSampler(
  options?: { readonly probe?: WorkspaceNetworkProbe },
): void {
  if (started) return;
  started = true;
  if (options?.probe !== undefined) probe = options.probe;
  unsubscribeEnvironments = subscribeCoderWorkspaceEnvironments(syncSamplers);
  if (typeof document !== "undefined") {
    visibilityListener = onVisibilityChange;
    document.addEventListener("visibilitychange", visibilityListener);
  }
  syncSamplers();
}

export function stopCoderWorkspaceNetworkSamplerForTests(): void {
  started = false;
  probe = defaultProbe;
  for (const sampler of samplers.values()) {
    if (sampler.timer !== undefined) clearTimeout(sampler.timer);
  }
  samplers.clear();
  network = {};
  unsubscribeEnvironments?.();
  unsubscribeEnvironments = null;
  if (visibilityListener !== null && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
  publish();
}
