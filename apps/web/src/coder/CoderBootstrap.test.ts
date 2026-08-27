import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  discardInactiveWorkspaceConnectionErrors,
  nextCoderSlowSampleCount,
  readWorkspaceRuntime,
  workspaceRuntimeRetryDelayMs,
} from "./CoderBootstrap";
import type { CoderProfileConfig } from "./api";

const config: CoderProfileConfig = {
  version: 1,
  deployments: [{ id: "deployment-one", name: "Deployment One", url: "https://coder.example.com" }],
  workspaces: [
    {
      id: "workspace-one",
      name: "Workspace One",
      deploymentId: "deployment-one",
      workspace: "owner/workspace-one",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coder workspace runtime discovery", () => {
  it("settles a failed status request as unavailable instead of checking forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(readWorkspaceRuntime(config)).resolves.toEqual({
      "workspace-one": {
        status: "unavailable",
        updateAvailable: false,
        healthy: null,
        autostopAt: null,
        error: "Could not fetch workspace status. Failed to fetch",
      },
    });
  });

  it("keeps an undiscovered workspace distinct from a failed status request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [] })),
    );

    await expect(readWorkspaceRuntime(config)).resolves.toEqual({
      "workspace-one": {
        status: "unknown",
        updateAvailable: false,
        healthy: null,
        autostopAt: null,
      },
    });
  });
});

describe("Coder workspace connection errors", () => {
  it.each(["stopped", "starting", "unavailable"] as const)(
    "clears a previous connection error when the workspace becomes %s",
    (status) => {
      expect(
        discardInactiveWorkspaceConnectionErrors(
          { "workspace-one": "Previous preflight failure" },
          {
            "workspace-one": {
              status,
              updateAvailable: false,
              healthy: null,
              autostopAt: null,
              ...(status === "unavailable" ? { error: "Status request failed" } : {}),
            },
          },
        ),
      ).toEqual({});
    },
  );

  it("retains a current connection error while the Coder workspace is running", () => {
    const errors = { "workspace-one": "Current preflight failure" };

    expect(
      discardInactiveWorkspaceConnectionErrors(errors, {
        "workspace-one": {
          status: "running",
          updateAvailable: false,
          healthy: true,
          autostopAt: null,
        },
      }),
    ).toBe(errors);
  });
});

describe("Coder adaptive status and network thresholds", () => {
  it("backs off status retries to a thirty-second ceiling", () => {
    expect([0, 1, 2, 3, 4, 9].map(workspaceRuntimeRetryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it("requires two slow samples and recovers without flicker", () => {
    const firstSlow = nextCoderSlowSampleCount(0, 300);
    const secondSlow = nextCoderSlowSampleCount(firstSlow, 300);
    expect(firstSlow).toBe(1);
    expect(secondSlow).toBe(2);
    expect(nextCoderSlowSampleCount(secondSlow, 20)).toBe(1);
  });
});
