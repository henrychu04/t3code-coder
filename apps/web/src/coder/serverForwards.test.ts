import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CoderProfileConfig } from "./api";
import { addServerForward, findServerForward, forwardServer } from "./serverForwards";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config: CoderProfileConfig = {
  version: 1,
  deployments: [{ id: "deployment", name: "Deployment", url: "https://coder.example.test" }],
  workspaces: [
    { id: "workspace", name: "Workspace", deploymentId: "deployment", workspace: "owner/one" },
  ],
  portForwards: [
    { id: "udp", workspaceId: "workspace", protocol: "udp", localPort: 5173, remotePort: 5173 },
  ],
} as CoderProfileConfig;

/** Answers the gateway's free-port request with 5174 and status reads with `status(rule)`. */
function stubGateway(
  read: () => CoderProfileConfig,
  status: (poll: number) => Record<string, unknown>,
) {
  const calls: string[] = [];
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
      if (path === "/api/port-forwards/free-port") return Response.json({ port: 5174 });
      if (path === "/api/config") return Response.json(read());
      polls += 1;
      return Response.json({
        portForwards: (read().portForwards ?? []).map((entry) => ({
          id: entry.id,
          ...status(polls),
        })),
      });
    }),
  );
  return calls;
}

function fakeUpdateConfig() {
  let current = config;
  const updateConfig = vi.fn(
    async (
      update: (value: CoderProfileConfig) => CoderProfileConfig | Promise<CoderProfileConfig>,
    ) => {
      current = await update(current);
    },
  );
  return { updateConfig, read: () => current };
}

describe("server forwards", () => {
  it("finds only a TCP forward of the server's workspace port", () => {
    expect(findServerForward(config, "workspace", 5173)).toBeUndefined();
    const added = addServerForward(config, {
      id: "tcp",
      workspaceId: "workspace",
      protocol: "tcp",
      localPort: 5174,
      remotePort: 5173,
    });
    expect(findServerForward(added, "workspace", 5173)?.id).toBe("tcp");
    expect(findServerForward(added, "other", 5173)).toBeUndefined();
  });

  it("refuses a local port another TCP rule already uses", () => {
    const rule = {
      id: "a",
      workspaceId: "workspace",
      protocol: "tcp",
      localPort: 5174,
      remotePort: 5173,
    } as const;
    expect(() => addServerForward(addServerForward(config, rule), { ...rule, id: "b" })).toThrow(
      /already configured/,
    );
  });

  it("saves a TCP rule at the gateway's free port and resolves once it is ready", async () => {
    const { updateConfig, read } = fakeUpdateConfig();
    const calls = stubGateway(read, (poll) => ({
      status: "running",
      ...(poll > 1 ? { ready: true } : {}),
    }));

    const rule = await forwardServer({ workspaceId: "workspace", remotePort: 5173, updateConfig });

    expect(rule).toMatchObject({
      workspaceId: "workspace",
      protocol: "tcp",
      localPort: 5174,
      remotePort: 5173,
    });
    expect(read().portForwards?.at(-1)).toEqual(rule);
    expect(calls).toEqual([
      'POST /api/port-forwards/free-port {"port":5173}',
      "GET /api/config",
      "GET /api/port-forwards",
      "GET /api/port-forwards",
    ]);
  });

  it("removes the rule again when the forward fails to start", async () => {
    const { updateConfig, read } = fakeUpdateConfig();
    stubGateway(read, () => ({ status: "error", error: "Local port 5174 is already in use." }));

    await expect(
      forwardServer({ workspaceId: "workspace", remotePort: 5173, updateConfig }),
    ).rejects.toThrow("Local port 5174 is already in use.");
    expect(read().portForwards).toEqual(config.portForwards);
  });
});
