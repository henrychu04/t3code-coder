import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { discardInactiveWorkspaceConnectionErrors, readWorkspaceRuntime } from "./CoderBootstrap";
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
      "workspace-one": { status: "unknown", updateAvailable: false },
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
        "workspace-one": { status: "running", updateAvailable: false },
      }),
    ).toBe(errors);
  });
});
