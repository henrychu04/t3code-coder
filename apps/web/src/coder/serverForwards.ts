// Forwards a dev server the thread's agent or terminals started to this computer as a normal saved
// port-forward rule, the same shape Settings → Port forwarding edits.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  useCoderSettingsConfig,
  type UpdateCoderSettingsConfig,
} from "../components/settings/useCoderSettingsConfig";
import { randomUUID } from "../lib/utils";
import {
  findFreeCoderForwardPort,
  loadCoderConfig,
  loadCoderPortForwardStatuses,
  type CoderPortForwardProfile,
  type CoderProfileConfig,
} from "./api";
import { useCoder } from "./CoderBootstrap";
import { coderWorkspaceIdForEnvironment } from "./environmentStore";

/**
 * The gateway's current configuration. A save replaces the whole configuration, and another tab
 * may have saved since this one loaded, so forward edits start from what the gateway holds.
 */
const latestConfig = () => loadCoderConfig();

/** How long Forward waits for Coder to report its listener ready before opening the tab anyway. */
const FORWARD_READY_TIMEOUT_MS = 20_000;
const FORWARD_READY_POLL_MS = 250;

/** The saved TCP forward that reaches `remotePort` in the workspace, if any. */
export function findServerForward(
  config: CoderProfileConfig,
  workspaceId: string,
  remotePort: number,
): CoderPortForwardProfile | undefined {
  return config.portForwards?.find(
    (rule) =>
      rule.workspaceId === workspaceId && rule.protocol === "tcp" && rule.remotePort === remotePort,
  );
}

/** Adds `rule` with the checks the port-forward editor makes before saving. */
export function addServerForward(
  current: CoderProfileConfig,
  rule: CoderPortForwardProfile,
): CoderProfileConfig {
  const rules = current.portForwards ?? [];
  if (!current.workspaces.some((workspace) => workspace.id === rule.workspaceId))
    throw new Error("The workspace connection was removed.");
  if (rules.some((entry) => entry.protocol === rule.protocol && entry.localPort === rule.localPort))
    throw new Error(`Local port ${rule.localPort} is already configured. Try again.`);
  return { ...current, portForwards: [...rules, rule] };
}

export function removeServerForward(
  current: CoderProfileConfig,
  ruleId: string,
): CoderProfileConfig {
  return {
    ...current,
    portForwards: (current.portForwards ?? []).filter((entry) => entry.id !== ruleId),
  };
}

export const forwardedServerUrl = (rule: Pick<CoderPortForwardProfile, "localPort">) =>
  `http://127.0.0.1:${rule.localPort}/`;

/** Saves and starts a forward of `remotePort`, then resolves once Coder reports it ready. */
export async function forwardServer(input: {
  readonly workspaceId: string;
  readonly remotePort: number;
  readonly updateConfig: UpdateCoderSettingsConfig;
}): Promise<CoderPortForwardProfile> {
  const { remotePort, updateConfig } = input;
  const rule: CoderPortForwardProfile = {
    id: `port-forward-${randomUUID()}`,
    workspaceId: input.workspaceId,
    protocol: "tcp",
    localPort: await findFreeCoderForwardPort(remotePort),
    remotePort,
  };
  // Saving starts the forward; the gateway answers once its process has spawned. Another tab may
  // have forwarded the same server first; that rule is used instead of adding a second one.
  let forwarded = rule;
  await updateConfig(async () => {
    const current = await latestConfig();
    const existing = findServerForward(current, rule.workspaceId, remotePort);
    if (existing !== undefined) {
      forwarded = existing;
      return current;
    }
    return addServerForward(current, rule);
  });
  const deadline = Date.now() + FORWARD_READY_TIMEOUT_MS;
  for (;;) {
    const status = (await loadCoderPortForwardStatuses()).find(
      (entry) => entry.id === forwarded.id,
    );
    const expired = Date.now() >= deadline;
    // Coder versions that never print `Ready!` still open once the wait runs out.
    if (status?.status === "running" && (status.ready === true || expired)) return forwarded;
    if (status?.status !== "running" && (status?.status !== "starting" || expired)) {
      // A forward this click added and that never ran is not kept, so Settings shows no rule to
      // explain; a rule another tab added stays.
      if (forwarded === rule) {
        await updateConfig(async () => removeServerForward(await latestConfig(), rule.id));
      }
      throw new Error(status?.error ?? "The port forward did not start.");
    }
    await new Promise((resolve) => setTimeout(resolve, FORWARD_READY_POLL_MS));
  }
}

/** Saved forwards for an environment's workspace, and the Forward and Stop forwarding actions. */
export function useServerForwards(environmentId: EnvironmentId) {
  const { config, saveConfig } = useCoder();
  const updateConfig = useCoderSettingsConfig(config, saveConfig);
  const workspaceId = coderWorkspaceIdForEnvironment(environmentId);

  const forwardFor = (remotePort: number) =>
    workspaceId === null ? undefined : findServerForward(config, workspaceId, remotePort);

  const forward = useCallback(
    (remotePort: number): Promise<CoderPortForwardProfile> =>
      workspaceId === null
        ? Promise.reject(new Error("This thread's workspace is not connected."))
        : forwardServer({ workspaceId, remotePort, updateConfig }),
    [updateConfig, workspaceId],
  );

  const stopForwarding = useCallback(
    (rule: CoderPortForwardProfile) =>
      updateConfig(async () => removeServerForward(await latestConfig(), rule.id)),
    [updateConfig],
  );

  return { canForward: workspaceId !== null, forwardFor, forward, stopForwarding };
}
