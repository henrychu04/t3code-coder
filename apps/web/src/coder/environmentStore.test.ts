import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  coderWorkspaceIdForEnvironment,
  readCoderWorkspaceEnvironments,
  removeCoderWorkspaceEnvironment,
  setCoderWorkspaceEnvironment,
  setCoderWorkspaceOrder,
  subscribeCoderWorkspaceEnvironmentRemovals,
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
    expect(coderWorkspaceIdForEnvironment("environment-b")).toBe("workspace-b");
    expect(coderWorkspaceIdForEnvironment("missing")).toBeNull();
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

  it("reports a configuration removal but not a stopped workspace", () => {
    const removed: string[] = [];
    const unsubscribe = subscribeCoderWorkspaceEnvironmentRemovals((environmentId) => {
      removed.push(environmentId);
    });
    try {
      setCoderWorkspaceOrder(["workspace-a", "workspace-b"]);
      setCoderWorkspaceEnvironment("workspace-a", descriptor("environment-a"));
      setCoderWorkspaceEnvironment("workspace-b", descriptor("environment-b"));

      removeCoderWorkspaceEnvironment("workspace-a");
      setCoderWorkspaceOrder(["workspace-a", "workspace-b"]);
      expect(removed).toEqual([]);

      setCoderWorkspaceOrder(["workspace-b"]);
      setCoderWorkspaceOrder(["workspace-b"]);
      expect(removed).toEqual(["environment-a"]);
    } finally {
      unsubscribe();
    }
  });
});
