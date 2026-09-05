import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkCoderDeploymentAuthentication,
  discoverCoderWorkspaces,
  loadCoderWorkspaceDiagnostics,
  loadCoderWorkspaceMetrics,
  restartCoderWorkspace,
  startCoderWorkspace,
  stopCoderWorkspace,
  updateCoderWorkspace,
  uploadCoderClipboardImage,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coder clipboard image API", () => {
  it("posts the clipboard image bytes to the selected workspace", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", {
      type: "image/png",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ path: "/home/user/.t3-coder/attachments/image.png" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadCoderClipboardImage("workspace one", file)).resolves.toBe(
      "/home/user/.t3-coder/attachments/image.png",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace%20one/clipboard-image",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: file,
      }),
    );
  });

  it("rejects unsupported clipboard image formats before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1])], "image.gif", { type: "image/gif" });

    await expect(uploadCoderClipboardImage("workspace", file)).rejects.toThrow(
      "Clipboard image must be PNG, JPEG, or WebP.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Coder authentication API", () => {
  it("returns the gateway's tri-state authentication result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkCoderDeploymentAuthentication("deployment one")).resolves.toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledWith("/api/deployments/deployment%20one/auth-status", {
      method: "POST",
    });
  });
});

describe("Coder workspace lifecycle API", () => {
  it("returns explicit Coder workspace lifecycle and update state", async () => {
    const workspaces = [
      {
        name: "Workspace One",
        target: "owner/workspace-one",
        status: "stopped",
        updateAvailable: true,
        healthy: true,
        autostopAt: "2026-08-25T18:30:00.000Z",
        requiredStopAt: null,
      },
    ] as const;
    const fetchMock = vi.fn(async () => Response.json({ workspaces }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverCoderWorkspaces("deployment one")).resolves.toEqual(workspaces);
  });

  it("loads validated workspace resource usage", async () => {
    const usage = {
      healthy: true,
      cpu: { used: 0.5, total: 4, unit: "cores" },
      memory: { used: 1024, total: 2048, unit: "B" },
      disk: { used: 4096, total: 8192, unit: "B" },
    };
    const fetchMock = vi.fn(async () => Response.json(usage));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadCoderWorkspaceMetrics("workspace one")).resolves.toEqual(usage);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/metrics", {
      cache: "no-store",
    });
  });

  it("reads the connection timeline", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadCoderWorkspaceDiagnostics("workspace one")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/diagnostics", {
      cache: "no-store",
    });
  });

  it("requests a start for the selected workspace", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "started" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCoderWorkspace("workspace one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/start", {
      method: "POST",
    });
  });

  it("requests a restart for the selected workspace", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "restarted" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restartCoderWorkspace("workspace one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/restart", {
      method: "POST",
    });
  });

  it("requests a stop for the selected workspace", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "stopped" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(stopCoderWorkspace("workspace one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/stop", {
      method: "POST",
    });
  });

  it("requests a template update for the selected workspace", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "updated" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateCoderWorkspace("workspace one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace%20one/update", {
      method: "POST",
    });
  });
});
