import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readCoderWorkspaceEnvironments,
  setCoderWorkspaceEnvironment,
  setCoderWorkspaceOrder,
} from "./environmentStore";

function descriptor(id: string) {
  return {
    environmentId: EnvironmentId.make(id),
    label: TrimmedNonEmptyString.make(id),
    platform: { os: "linux" as const, arch: "x64" as const },
    serverVersion: TrimmedNonEmptyString.make("0.0.33"),
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  };
}

afterEach(() => setCoderWorkspaceOrder([]));

describe("Coder workspace environment store", () => {
  it("keeps configured workspace order regardless of connection completion order", () => {
    setCoderWorkspaceOrder(["workspace-a", "workspace-b"]);
    setCoderWorkspaceEnvironment("workspace-b", descriptor("environment-b"));
    setCoderWorkspaceEnvironment("workspace-a", descriptor("environment-a"));

    expect(readCoderWorkspaceEnvironments().map((entry) => entry.workspaceId)).toEqual([
      "workspace-a",
      "workspace-b",
    ]);
  });

  it("removes environments that are no longer configured", () => {
    setCoderWorkspaceOrder(["workspace-a", "workspace-b"]);
    setCoderWorkspaceEnvironment("workspace-a", descriptor("environment-a"));
    setCoderWorkspaceEnvironment("workspace-b", descriptor("environment-b"));

    setCoderWorkspaceOrder(["workspace-b"]);

    expect(readCoderWorkspaceEnvironments().map((entry) => entry.workspaceId)).toEqual([
      "workspace-b",
    ]);
  });
});
