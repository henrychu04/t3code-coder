import { expect, it } from "vite-plus/test";

import type { CoderProfileConfig, DiscoveredCoderWorkspace } from "./api";
import { addableCoderWorkspaces } from "./useCoderWorkspaceDiscovery";

const workspace = (target: string): DiscoveredCoderWorkspace => ({
  name: target.split("/").at(-1)!,
  target,
  status: "running",
  updateAvailable: false,
  healthy: true,
  autostopAt: null,
  requiredStopAt: null,
});

const config: CoderProfileConfig = {
  version: 1,
  deployments: [
    { id: "cloud", name: "Cloud", url: "https://cloud.example.com" },
    { id: "onprem", name: "On-prem", url: "https://onprem.example.com" },
  ],
  workspaces: [
    { id: "main", name: "main", deploymentId: "cloud", workspace: "me/main" },
    { id: "idle", name: "idle", deploymentId: "cloud", workspace: "me/idle" },
  ],
};

it("lists unconnected workspaces per domain and keeps loading and error states", () => {
  const result = addableCoderWorkspaces(
    config,
    {
      cloud: {
        status: "ready",
        workspaces: [workspace("me/main"), workspace("me/idle"), workspace("me/new")],
      },
      onprem: { status: "error", error: "not signed in" },
    },
    new Set(["main"]),
  );
  expect(result).toEqual([
    {
      deploymentId: "cloud",
      deploymentName: "Cloud",
      discovery: { status: "ready", workspaces: [workspace("me/idle"), workspace("me/new")] },
    },
    {
      deploymentId: "onprem",
      deploymentName: "On-prem",
      discovery: { status: "error", error: "not signed in" },
    },
  ]);
});

it("omits domains that are undiscovered or have nothing left to connect", () => {
  expect(
    addableCoderWorkspaces(
      config,
      { cloud: { status: "ready", workspaces: [workspace("me/main")] } },
      new Set(["main"]),
    ),
  ).toEqual([]);
});
