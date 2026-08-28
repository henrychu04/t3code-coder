// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "node:test";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { WebSocket } from "ws";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";

import {
  buildCoderHelperInvocation,
  buildCoderRestartWorkspaceInvocation,
  buildCoderStartWorkspaceInvocation,
  buildCoderStopWorkspaceInvocation,
  buildCoderUpdateWorkspaceInvocation,
  buildCoderWorkspaceStatsInvocation,
  quotePosixShellArgument,
  REMOTE_WORKSPACE_PROBE_COMMAND,
} from "@t3tools/coder-cli/command";
import {
  CODER_GATEWAY_HOST,
  makeLocalCoderGateway,
  parseCoderWorkspaceResourceUsage,
  runCoderAuthStatus,
  startLocalCoderGateway,
  type PromiseCoderHelperConnection as CoderHelperConnection,
} from "./server.ts";

let closeGateway: (() => Promise<void>) | undefined;
const tempDirectories: string[] = [];
const helperInfo: CoderHelperConnection["info"] = {
  protocolVersion: 1,
  platform: "linux",
  architecture: "x64",
  environment: {
    environmentId: EnvironmentId.make("environment-test"),
    label: TrimmedNonEmptyString.make("Coder workspace"),
    platform: { os: "linux", arch: "x64" },
    serverVersion: TrimmedNonEmptyString.make("0.0.33"),
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
};

afterEach(async () => {
  await closeGateway?.();
  closeGateway = undefined;
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFS.rm(directory, { recursive: true, force: true })),
  );
});

describe("Coder workspace resource usage", () => {
  it("parses Coder stat JSON without accepting malformed totals", () => {
    deepStrictEqual(
      parseCoderWorkspaceResourceUsage(
        JSON.stringify({
          cpu: { used: 0.75, total: 4, unit: "cores" },
          memory: { used: 3_221_225_472, total: 8_589_934_592, unit: "B" },
          disk: { used: 42_949_672_960, total: 107_374_182_400, unit: "B" },
        }),
      ),
      {
        cpu: { used: 0.75, total: 4, unit: "cores" },
        memory: { used: 3_221_225_472, total: 8_589_934_592, unit: "B" },
        disk: { used: 42_949_672_960, total: 107_374_182_400, unit: "B" },
      },
    );
    throws(
      () =>
        parseCoderWorkspaceResourceUsage(
          JSON.stringify({
            cpu: { used: 0.75, total: 4, unit: "cores" },
            memory: { used: 1024, total: 0, unit: "B" },
            disk: { used: 4096, total: 8192, unit: "B" },
          }),
        ),
      /invalid memory usage/u,
    );
  });
});

function request(input: {
  readonly url: string;
  readonly host?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
}) {
  return new Promise<{
    readonly statusCode: number;
    readonly headers: NodeHttp.IncomingHttpHeaders;
    readonly body: string;
  }>((resolve, reject) => {
    const url = new URL(input.url);
    const request = NodeHttp.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: input.method ?? "GET",
        headers: {
          ...(input.host === undefined ? {} : { Host: input.host }),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

describe("local Coder gateway", () => {
  it("binds to IPv4 loopback and serves no-store responses", async () => {
    const gateway = await startLocalCoderGateway();
    closeGateway = gateway.close;
    strictEqual(new URL(gateway.url).hostname, CODER_GATEWAY_HOST);
    const response = await request({ url: `${gateway.url}/healthz` });
    strictEqual(response.statusCode, 200);
    strictEqual(response.body, '{"status":"ok"}');
    strictEqual(
      response.headers["content-security-policy"]?.includes("script-src 'self' 'wasm-unsafe-eval'"),
      true,
    );
    strictEqual(
      response.headers["content-security-policy"]?.includes("script-src 'self' 'unsafe-eval'"),
      false,
    );
    strictEqual(
      response.headers["content-security-policy"]?.includes("img-src 'self' data: blob:"),
      true,
    );
    const webIndex = await NodeFS.readFile(
      new URL("../../web/index.html", import.meta.url),
      "utf8",
    );
    const bootScript = webIndex.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    strictEqual(typeof bootScript, "string");
    const bootScriptHash = createHash("sha256")
      .update(bootScript ?? "")
      .digest("base64");
    strictEqual(
      response.headers["content-security-policy"]?.includes(`'sha256-${bootScriptHash}'`),
      true,
    );
  });

  it("rejects an unexpected Host header", async () => {
    const gateway = await startLocalCoderGateway();
    closeGateway = gateway.close;
    const response = await request({ url: gateway.url, host: "attacker.example" });
    strictEqual(response.statusCode, 421);
  });

  it("returns 404 for a static directory path without crashing", async () => {
    const staticDir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-static-"));
    tempDirectories.push(staticDir);
    await NodeFS.mkdir(NodePath.join(staticDir, "assets"));
    const gateway = await startLocalCoderGateway({ staticDir });
    closeGateway = gateway.close;

    const directoryResponse = await request({ url: `${gateway.url}/assets` });
    strictEqual(directoryResponse.statusCode, 404);
    const healthResponse = await request({ url: `${gateway.url}/healthz` });
    strictEqual(healthResponse.statusCode, 200);
  });

  it("persists config only for the exact loopback origin", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const gateway = await startLocalCoderGateway({ configPath });
    closeGateway = gateway.close;
    const body = JSON.stringify({
      version: 1,
      deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
      workspaces: [],
    });

    const rejected = await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body,
    });
    strictEqual(rejected.statusCode, 403);

    const accepted = await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body,
    });
    strictEqual(accepted.statusCode, 200);
    strictEqual(JSON.parse(await NodeFS.readFile(configPath, "utf8")).version, 1);
  });

  it("auto-starts, reports, restarts, and removes configured port forwards", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    await NodeFS.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
        portForwards: [
          {
            id: "web",
            workspaceId: "project-one",
            protocol: "tcp",
            localPort: 8080,
            remotePort: 3000,
          },
        ],
      }),
    );
    const invocations: Array<{ readonly executable: string; readonly args: readonly string[] }> =
      [];
    const exits: Array<(exit: { readonly expected: boolean; readonly reason?: string }) => void> =
      [];
    let closeCount = 0;
    const gateway = await startLocalCoderGateway({
      configPath,
      connectPortForward: async (invocation) => {
        invocations.push(invocation);
        let resolveClosed:
          | ((exit: { readonly expected: boolean; readonly reason?: string }) => void)
          | undefined;
        const closed = new Promise<{ readonly expected: boolean; readonly reason?: string }>(
          (resolve) => {
            resolveClosed = resolve;
          },
        );
        exits.push((exit) => resolveClosed?.(exit));
        return {
          closed: closed.then((exit) => ({ code: null, signal: null, ...exit })),
          close: () => {
            closeCount += 1;
            resolveClosed?.({ expected: true });
          },
        };
      },
    });
    closeGateway = gateway.close;

    deepStrictEqual(invocations, [
      {
        executable: "coder",
        args: [
          "--global-config",
          NodePath.join(directory, "coder-profiles", "goldman"),
          "--no-version-warning",
          "--url",
          "https://coder.example.gs.com",
          "port-forward",
          "henry/project-one",
          "--tcp",
          "127.0.0.1:8080:3000",
        ],
      },
    ]);
    deepStrictEqual(JSON.parse((await request({ url: `${gateway.url}/api/port-forwards` })).body), {
      portForwards: [{ id: "web", status: "running" }],
    });

    exits[0]?.({ expected: false, reason: "Local port 8080 is already in use." });
    await Promise.resolve();
    deepStrictEqual(JSON.parse((await request({ url: `${gateway.url}/api/port-forwards` })).body), {
      portForwards: [{ id: "web", status: "error", error: "Local port 8080 is already in use." }],
    });

    const rejectedRestart = await request({
      url: `${gateway.url}/api/port-forwards/web/restart`,
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    strictEqual(rejectedRestart.statusCode, 403);
    const restarted = await request({
      url: `${gateway.url}/api/port-forwards/web/restart`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(restarted.statusCode, 200);
    strictEqual(invocations.length, 2);

    const removed = await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
        portForwards: [],
      }),
    });
    strictEqual(removed.statusCode, 200);
    strictEqual(closeCount, 1);
    deepStrictEqual(JSON.parse((await request({ url: `${gateway.url}/api/port-forwards` })).body), {
      portForwards: [],
    });
  });

  it("keeps a stopped workspace and its saved port forwards stopped until an explicit start", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    await NodeFS.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
        portForwards: [
          {
            id: "web",
            workspaceId: "project-one",
            protocol: "tcp",
            localPort: 8080,
            remotePort: 3000,
          },
        ],
      }),
    );
    let portForwardStarts = 0;
    let startCommands = 0;
    const gateway = await startLocalCoderGateway({
      configPath,
      listWorkspaces: async () => [
        {
          name: "project-one",
          target: "henry/project-one",
          status: "stopped",
          updateAvailable: false,
          healthy: null,
          autostopAt: null,
          requiredStopAt: null,
        },
      ],
      startWorkspace: async () => {
        startCommands += 1;
      },
      connectPortForward: async () => {
        portForwardStarts += 1;
        let resolveClosed:
          | ((exit: {
              readonly code: null;
              readonly signal: null;
              readonly expected: true;
            }) => void)
          | undefined;
        return {
          closed: new Promise((resolve) => {
            resolveClosed = resolve;
          }),
          close: () => resolveClosed?.({ code: null, signal: null, expected: true }),
        };
      },
    });
    closeGateway = gateway.close;

    strictEqual(portForwardStarts, 0);
    deepStrictEqual(JSON.parse((await request({ url: `${gateway.url}/api/port-forwards` })).body), {
      portForwards: [{ id: "web", status: "stopped" }],
    });

    const started = await request({
      url: `${gateway.url}/api/workspaces/project-one/start`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(started.statusCode, 200);
    strictEqual(startCommands, 1);
    strictEqual(portForwardStarts, 1);
  });

  it("coordinates the helper and saved port forwards around restart and stop", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const lifecycle: string[] = [];
    let receivedRestartInvocation:
      | { readonly executable: string; readonly args: readonly string[] }
      | undefined;
    let receivedStopInvocation:
      | { readonly executable: string; readonly args: readonly string[] }
      | undefined;
    let closeConnection:
      | ((exit: { code: number; signal: null; expected: true }) => void)
      | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = resolve;
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => {
          lifecycle.push("close");
          closeConnection?.({ code: 130, signal: null, expected: true });
        },
      }),
      listWorkspaces: async () => [
        {
          name: "project-one",
          target: "henry/project-one",
          status: "running",
          updateAvailable: false,
          healthy: true,
          autostopAt: null,
          requiredStopAt: null,
        },
      ],
      connectPortForward: async () => {
        lifecycle.push("forward-start");
        let resolveClosed:
          | ((exit: { readonly expected: true; readonly reason?: string }) => void)
          | undefined;
        const portForwardClosed = new Promise<{
          readonly expected: true;
          readonly reason?: string;
        }>((resolve) => {
          resolveClosed = resolve;
        });
        return {
          closed: portForwardClosed.then((exit) => ({ code: null, signal: null, ...exit })),
          close: () => {
            lifecycle.push("forward-close");
            resolveClosed?.({ expected: true });
          },
        };
      },
      restartWorkspace: async (invocation) => {
        lifecycle.push("restart");
        receivedRestartInvocation = invocation;
      },
      stopWorkspace: async (invocation) => {
        lifecycle.push("stop");
        receivedStopInvocation = invocation;
      },
    });
    closeGateway = gateway.close;
    const deployment = {
      id: "goldman",
      name: "Goldman",
      url: "https://coder.example.gs.com",
    } as const;
    const workspace = {
      id: "project-one",
      name: "Project One",
      deploymentId: "goldman",
      workspace: "henry/project-one",
    } as const;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [deployment],
        workspaces: [workspace],
        portForwards: [
          {
            id: "web",
            workspaceId: workspace.id,
            protocol: "tcp",
            localPort: 8080,
            remotePort: 3000,
          },
        ],
      }),
    });
    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    const rejected = await request({
      url: `${gateway.url}/api/workspaces/project-one/restart`,
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    strictEqual(rejected.statusCode, 403);

    const restarted = await request({
      url: `${gateway.url}/api/workspaces/project-one/restart`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(restarted.statusCode, 200);
    strictEqual(restarted.body, '{"status":"restarted"}');
    deepStrictEqual(lifecycle, [
      "forward-start",
      "close",
      "forward-close",
      "restart",
      "forward-start",
    ]);
    deepStrictEqual(
      receivedRestartInvocation,
      buildCoderRestartWorkspaceInvocation(deployment, workspace, {
        globalConfig: NodePath.join(directory, "coder-profiles", "goldman"),
      }),
    );
    const connections = await request({ url: `${gateway.url}/api/connections` });
    deepStrictEqual(JSON.parse(connections.body), []);

    const stopped = await request({
      url: `${gateway.url}/api/workspaces/project-one/stop`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(stopped.statusCode, 200);
    strictEqual(stopped.body, '{"status":"stopped"}');
    deepStrictEqual(lifecycle, [
      "forward-start",
      "close",
      "forward-close",
      "restart",
      "forward-start",
      "forward-close",
      "stop",
    ]);
    deepStrictEqual(
      receivedStopInvocation,
      buildCoderStopWorkspaceInvocation(deployment, workspace, {
        globalConfig: NodePath.join(directory, "coder-profiles", "goldman"),
      }),
    );
    deepStrictEqual(JSON.parse((await request({ url: `${gateway.url}/api/port-forwards` })).body), {
      portForwards: [{ id: "web", status: "stopped" }],
    });
  });

  it("starts and updates a configured workspace through Coder", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const invocations: Array<{ readonly executable: string; readonly args: readonly string[] }> =
      [];
    const gateway = await startLocalCoderGateway({
      configPath,
      startWorkspace: async (invocation) => {
        invocations.push(invocation);
      },
      updateWorkspace: async (invocation) => {
        invocations.push(invocation);
      },
    });
    closeGateway = gateway.close;
    const deployment = {
      id: "goldman",
      name: "Goldman",
      url: "https://coder.example.gs.com",
    } as const;
    const workspace = {
      id: "project-one",
      name: "Project One",
      deploymentId: "goldman",
      workspace: "henry/project-one",
    } as const;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, deployments: [deployment], workspaces: [workspace] }),
    });

    const started = await request({
      url: `${gateway.url}/api/workspaces/project-one/start`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    const updated = await request({
      url: `${gateway.url}/api/workspaces/project-one/update`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    strictEqual(started.statusCode, 200);
    strictEqual(started.body, '{"status":"started"}');
    strictEqual(updated.statusCode, 200);
    strictEqual(updated.body, '{"status":"updated"}');
    deepStrictEqual(invocations, [
      buildCoderStartWorkspaceInvocation(deployment, workspace, {
        globalConfig: NodePath.join(directory, "coder-profiles", "goldman"),
      }),
      buildCoderUpdateWorkspaceInvocation(deployment, workspace, {
        globalConfig: NodePath.join(directory, "coder-profiles", "goldman"),
      }),
    ]);
  });

  it("shares the same workspace action and rejects a conflicting transition", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let restartCount = 0;
    let releaseRestart: (() => void) | undefined;
    let signalRestartStarted: (() => void) | undefined;
    const restartStarted = new Promise<void>((resolve) => {
      signalRestartStarted = resolve;
    });
    const restartReleased = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      restartWorkspace: async () => {
        restartCount += 1;
        signalRestartStarted?.();
        await restartReleased;
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const firstRestart = request({
      url: `${gateway.url}/api/workspaces/project-one/restart`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    await restartStarted;
    const duplicateRestart = request({
      url: `${gateway.url}/api/workspaces/project-one/restart`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    const conflictingUpdate = await request({
      url: `${gateway.url}/api/workspaces/project-one/update`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    strictEqual(conflictingUpdate.statusCode, 409);
    strictEqual(conflictingUpdate.body, "Coder workspace is already restarting.");
    strictEqual(restartCount, 1);
    releaseRestart?.();
    const restartResponses = await Promise.all([firstRestart, duplicateRestart]);
    deepStrictEqual(
      restartResponses.map((response) => response.statusCode),
      [200, 200],
    );
    strictEqual(restartCount, 1);
  });

  it("discovers workspaces through the configured deployment's Coder domain", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let receivedInvocation:
      | { readonly executable: string; readonly args: readonly string[] }
      | undefined;
    const gateway = await startLocalCoderGateway({
      configPath,
      listWorkspaces: async (invocation) => {
        receivedInvocation = invocation;
        return [
          {
            name: "project-one",
            target: "henry/project-one",
            status: "running",
            updateAvailable: true,
            healthy: true,
            autostopAt: null,
            requiredStopAt: null,
          },
        ];
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [],
      }),
    });

    const rejected = await request({
      url: `${gateway.url}/api/deployments/goldman/workspaces`,
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    strictEqual(rejected.statusCode, 403);

    const discovered = await request({
      url: `${gateway.url}/api/deployments/goldman/workspaces`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(discovered.statusCode, 200);
    deepStrictEqual(JSON.parse(discovered.body), {
      workspaces: [
        {
          name: "project-one",
          target: "henry/project-one",
          status: "running",
          updateAvailable: true,
          healthy: true,
          autostopAt: null,
          requiredStopAt: null,
        },
      ],
    });
    deepStrictEqual(receivedInvocation, {
      executable: "coder",
      args: [
        "--global-config",
        NodePath.join(directory, "coder-profiles", "goldman"),
        "--no-version-warning",
        "--url",
        "https://coder.example.gs.com",
        "list",
        "--output",
        "json",
      ],
    });
  });

  it("reports effective and required stop deadlines only for active start builds", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify([
  { name: "starting-workspace", owner_name: "henry", ttl_ms: 1800000, latest_build: { transition: "start", status: "starting", deadline: "2026-08-25T18:30:00Z" }, outdated: true, health: { healthy: true } },
  { name: "template-default-workspace", latest_build: { transition: "start", status: "running", deadline: "2026-08-25T19:00:00Z" }, outdated: false },
  { name: "required-stop-workspace", latest_build: { transition: "start", status: "running", deadline: "2026-08-25T19:30:00Z", max_deadline: "2026-08-25T19:30:00Z" }, outdated: false },
  { name: "manual-workspace", latest_build: { transition: "start", status: "running" }, outdated: false },
  { name: "stopped-workspace", latest_build: { transition: "stop", status: "stopped", deadline: "2026-08-25T20:30:00Z", max_deadline: "2026-08-25T20:30:00Z" }, outdated: false },
  { name: "unknown-workspace", latest_build: { status: "failed" }, outdated: false }
]));
`,
      { mode: 0o700 },
    );
    const gateway = await startLocalCoderGateway({ configPath });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [],
      }),
    });

    const response = await request({
      url: `${gateway.url}/api/deployments/goldman/workspaces`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    strictEqual(response.statusCode, 200);
    deepStrictEqual(JSON.parse(response.body), {
      workspaces: [
        {
          name: "starting-workspace",
          target: "henry/starting-workspace",
          status: "starting",
          updateAvailable: true,
          healthy: true,
          autostopAt: "2026-08-25T18:30:00.000Z",
          requiredStopAt: null,
        },
        {
          name: "template-default-workspace",
          target: "template-default-workspace",
          status: "running",
          updateAvailable: false,
          healthy: null,
          autostopAt: "2026-08-25T19:00:00.000Z",
          requiredStopAt: null,
        },
        {
          name: "required-stop-workspace",
          target: "required-stop-workspace",
          status: "running",
          updateAvailable: false,
          healthy: null,
          autostopAt: "2026-08-25T19:30:00.000Z",
          requiredStopAt: "2026-08-25T19:30:00.000Z",
        },
        {
          name: "manual-workspace",
          target: "manual-workspace",
          status: "running",
          updateAvailable: false,
          healthy: null,
          autostopAt: null,
          requiredStopAt: null,
        },
        {
          name: "stopped-workspace",
          target: "stopped-workspace",
          status: "stopped",
          updateAvailable: false,
          healthy: null,
          autostopAt: null,
          requiredStopAt: null,
        },
        {
          name: "unknown-workspace",
          target: "unknown-workspace",
          status: "unknown",
          updateAvailable: false,
          healthy: null,
          autostopAt: null,
          requiredStopAt: null,
        },
      ],
    });
  });

  it("shares one interactive login process per deployment", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    const invocationLogPath = NodePath.join(directory, "login-invocations.txt");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
import * as fs from "node:fs";
fs.appendFileSync(${JSON.stringify(invocationLogPath)}, "login\\n");
setTimeout(() => process.exit(0), 100);
`,
      { mode: 0o700 },
    );
    const gateway = await startLocalCoderGateway({ configPath });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [],
      }),
    });
    const loginRequest = () =>
      request({
        url: `${gateway.url}/api/deployments/goldman/login`,
        method: "POST",
        headers: { Origin: gateway.url },
      });

    const concurrent = await Promise.all([loginRequest(), loginRequest()]);
    deepStrictEqual(
      concurrent.map((response) => response.statusCode),
      [200, 200],
    );
    strictEqual((await NodeFS.readFile(invocationLogPath, "utf8")).trim().split("\n").length, 1);

    strictEqual((await loginRequest()).statusCode, 200);
    strictEqual((await NodeFS.readFile(invocationLogPath, "utf8")).trim().split("\n").length, 2);
  });

  it("connects a configured workspace through its deployment-specific Coder invocation", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let closeConnection:
      | ((exit: { code: number; signal: null; expected: true }) => void)
      | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = resolve;
    });
    let receivedProbeArgs: readonly string[] = [];
    let receivedHelperArgs: readonly string[] = [];
    const lifecycle: string[] = [];
    const connection: CoderHelperConnection = {
      info: helperInfo,
      closed,
      sendRpc: () => undefined,
      onRpcMessage: () => () => undefined,
      close: () => closeConnection?.({ code: 130, signal: null, expected: true }),
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async (invocation) => {
        lifecycle.push("probe");
        receivedProbeArgs = invocation.args;
      },
      connectHelper: async (invocation) => {
        lifecycle.push("connect");
        receivedHelperArgs = invocation.args;
        return connection;
      },
    });
    closeGateway = gateway.close;
    const configBody = JSON.stringify({
      version: 1,
      deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
      workspaces: [
        {
          id: "project-one",
          name: "Project One",
          deploymentId: "goldman",
          workspace: "henry/project-one",
        },
      ],
    });
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: configBody,
    });

    const connected = await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(connected.statusCode, 200);
    strictEqual(JSON.parse(connected.body).info.platform, "linux");
    deepStrictEqual(lifecycle, ["probe", "connect"]);
    deepStrictEqual(receivedProbeArgs, [
      "--global-config",
      NodePath.join(directory, "coder-profiles", "goldman"),
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "henry/project-one",
      "--",
      "sh",
      "-l",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
    ]);
    deepStrictEqual(
      receivedHelperArgs,
      buildCoderHelperInvocation(
        {
          id: "goldman",
          name: "Goldman",
          url: "https://coder.example.gs.com",
        },
        {
          id: "project-one",
          name: "Project One",
          deploymentId: "goldman",
          workspace: "henry/project-one",
        },
        { globalConfig: NodePath.join(directory, "coder-profiles", "goldman") },
      ).args,
    );
  });

  it("streams one foreground Coder ping per connected workspace", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    const invocationLogPath = NodePath.join(directory, "ping-invocations.txt");
    const lifecycleLogPath = NodePath.join(directory, "ping-lifecycle.txt");
    await NodeFS.writeFile(
      executablePath,
      `#!/usr/bin/env node
import * as fs from "node:fs";
fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
fs.appendFileSync(${JSON.stringify(lifecycleLogPath)}, "started\\n");
process.stdout.write("pong from henry/project-one proxied via DERP(test) in 37ms\\n");
const timer = setInterval(() => process.stdout.write("pong from henry/project-one proxied via DERP(test) in 35ms\\n"), 25);
process.on("SIGTERM", () => {
  clearInterval(timer);
  fs.appendFileSync(${JSON.stringify(lifecycleLogPath)}, "stopped\\n");
  process.exit(0);
});
`,
      { mode: 0o700 },
    );
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.(),
      }),
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });
    strictEqual(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/latency`,
        })
      ).statusCode,
      409,
    );
    strictEqual(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/connection`,
          method: "POST",
          headers: { Origin: gateway.url },
        })
      ).statusCode,
      200,
    );

    let sample: { readonly latencyMs: number; readonly sampledAt: number } | null = null;
    for (let attempt = 0; attempt < 50 && sample === null; attempt += 1) {
      const response = await request({
        url: `${gateway.url}/api/workspaces/project-one/latency`,
      });
      strictEqual(response.statusCode, 200);
      sample = (
        JSON.parse(response.body) as {
          sample: { readonly latencyMs: number; readonly sampledAt: number } | null;
        }
      ).sample;
      if (sample === null) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    strictEqual(sample?.latencyMs === 37 || sample?.latencyMs === 35, true);
    strictEqual(typeof sample?.sampledAt, "number");
    strictEqual(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/latency`,
        })
      ).statusCode,
      200,
    );
    const invocations = (await NodeFS.readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    strictEqual(invocations.length, 1);
    deepStrictEqual(invocations[0], [
      "--global-config",
      NodePath.join(directory, "coder-profiles", "goldman"),
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
      "ping",
      "henry/project-one",
    ]);
    const connectedDiagnostics = JSON.parse(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/diagnostics`,
        })
      ).body,
    ) as { events: Array<{ phase: string; status: string }> };
    deepStrictEqual(
      connectedDiagnostics.events.map(({ phase, status }) => ({ phase, status })),
      [
        { phase: "preflight", status: "completed" },
        { phase: "negotiating_helper", status: "completed" },
        { phase: "connected", status: "completed" },
      ],
    );

    strictEqual(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/connection`,
          method: "DELETE",
          headers: { Origin: gateway.url },
        })
      ).statusCode,
      200,
    );
    strictEqual(
      (await NodeFS.readFile(lifecycleLogPath, "utf8")).trim().split("\n").at(-1),
      "stopped",
    );
    const disconnectedDiagnostics = JSON.parse(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/diagnostics`,
        })
      ).body,
    ) as { events: Array<{ phase: string }> };
    strictEqual(disconnectedDiagnostics.events.at(-1)?.phase, "disconnected");
  });

  it("samples workspace resource usage only while the helper is connected", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const invocations: Array<ReturnType<typeof buildCoderWorkspaceStatsInvocation>> = [];
    const usage = {
      cpu: { used: 0.75, total: 4, unit: "cores" as const },
      memory: { used: 3_221_225_472, total: 8_589_934_592, unit: "B" as const },
      disk: { used: 42_949_672_960, total: 107_374_182_400, unit: "B" as const },
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.(),
      }),
      readWorkspaceResourceUsage: async (invocation) => {
        invocations.push(invocation);
        return usage;
      },
      listWorkspaces: async () => [
        {
          name: "project-one",
          target: "henry/project-one",
          status: "running",
          updateAvailable: false,
          healthy: true,
          autostopAt: null,
          requiredStopAt: null,
        },
      ],
    });
    closeGateway = gateway.close;
    const deployment = {
      id: "goldman",
      name: "Goldman",
      url: "https://coder.example.gs.com",
    };
    const workspace = {
      id: "project-one",
      name: "Project One",
      deploymentId: "goldman",
      workspace: "henry/project-one",
    };
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [deployment],
        workspaces: [workspace],
      }),
    });

    strictEqual(
      (await request({ url: `${gateway.url}/api/workspaces/project-one/metrics` })).statusCode,
      409,
    );
    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    const response = await request({
      url: `${gateway.url}/api/workspaces/project-one/metrics`,
    });
    strictEqual(response.statusCode, 200);
    deepStrictEqual(JSON.parse(response.body), { healthy: true, ...usage });
    deepStrictEqual(invocations, [
      buildCoderWorkspaceStatsInvocation(deployment, workspace, {
        globalConfig: NodePath.join(directory, "coder-profiles", "goldman"),
      }),
    ]);
  });

  it("reports remote preflight failures emitted on stdout", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    await NodeFS.writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("T3 Coder requires Nix in the workspace PATH.\\n");',
        'process.stderr.write("version mismatch: client v2.25.3, server v2.34.5\\n");',
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o700 },
    );
    const gateway = await startLocalCoderGateway({ configPath });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const response = await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(response.statusCode, 502);
    strictEqual(
      response.body,
      "Coder workspace preflight exited with code 1 (null). " +
        "T3 Coder requires Nix in the workspace PATH.\n" +
        "version mismatch: client v2.25.3, server v2.34.5",
    );
  });

  it("allows verbose preflight output while retaining the final success marker", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    await NodeFS.writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'process.stderr.write("x".repeat(64 * 1024));',
        'process.stdout.write("T3_CODER_PREFLIGHT_OK\\n");',
      ].join("\n"),
      { mode: 0o700 },
    );
    let closeConnection:
      | ((exit: { code: number; signal: null; expected: true }) => void)
      | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = resolve;
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.({ code: 130, signal: null, expected: true }),
      }),
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const response = await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(response.statusCode, 200);
  });

  it("times out when the remote workspace preflight stops responding", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const executablePath = NodePath.join(directory, "coder");
    await NodeFS.writeFile(
      executablePath,
      ["#!/usr/bin/env node", "setInterval(() => undefined, 1000);"].join("\n"),
      { mode: 0o700 },
    );
    const gateway = await startLocalCoderGateway({
      configPath,
      workspaceProbeTimeoutMs: 25,
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
            executable: executablePath,
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const response = await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(response.statusCode, 502);
    strictEqual(
      response.body,
      "Coder workspace preflight timed out. Check that the workspace is running. On first connection, its configured nixpkgs and Nix substituters must be reachable.",
    );
  });

  it("checks authentication through the deployment's isolated Coder 2.25 profile", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let receivedInvocation:
      | { readonly executable: string; readonly args: readonly string[] }
      | undefined;
    const gateway = await startLocalCoderGateway({
      configPath,
      checkAuthentication: async (invocation) => {
        receivedInvocation = invocation;
        return "authenticated";
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [],
      }),
    });

    const status = await request({
      url: `${gateway.url}/api/deployments/goldman/auth-status`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    strictEqual(status.statusCode, 200);
    deepStrictEqual(JSON.parse(status.body), { status: "authenticated" });
    deepStrictEqual(receivedInvocation, {
      executable: "coder",
      args: [
        "--global-config",
        NodePath.join(directory, "coder-profiles", "goldman"),
        "--no-version-warning",
        "--verbose",
        "--url",
        "https://coder.example.gs.com",
        "whoami",
      ],
    });
  });

  it("distinguishes unavailable Coder deployments from expired authentication", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const executablePath = NodePath.join(directory, "coder");
    const invocation = { executable: executablePath, args: [] };

    await NodeFS.writeFile(executablePath, "#!/usr/bin/env node\nprocess.exit(0);\n", {
      mode: 0o700,
    });
    strictEqual(await runCoderAuthStatus(invocation), "authenticated");

    await NodeFS.writeFile(
      executablePath,
      '#!/usr/bin/env node\nprocess.stderr.write("API request failed. Status code 401\\n");\nprocess.exit(1);\n',
      { mode: 0o700 },
    );
    strictEqual(await runCoderAuthStatus(invocation), "unauthenticated");

    await NodeFS.writeFile(
      executablePath,
      '#!/usr/bin/env node\nprocess.stderr.write("API request failed. Status code 503\\n");\nprocess.exit(1);\n',
      { mode: 0o700 },
    );
    strictEqual(await runCoderAuthStatus(invocation), "unavailable");

    strictEqual(
      await runCoderAuthStatus({ executable: NodePath.join(directory, "missing-coder"), args: [] }),
      "unavailable",
    );

    await NodeFS.writeFile(
      executablePath,
      '#!/usr/bin/env node\nprocess.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1_000);\n',
      { mode: 0o700 },
    );
    const timeoutStartedAt = Date.now();
    strictEqual(await runCoderAuthStatus(invocation, 100, 30), "unavailable");
    strictEqual(Date.now() - timeoutStartedAt >= 120, true);
  });

  it("uploads a validated clipboard image only for a connected workspace", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    let stagedPath = "";
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.(),
      }),
      uploadClipboardImage: async (input) => {
        stagedPath = input.localPath;
        strictEqual(input.extension, "png");
        strictEqual((await NodeFS.readFile(input.localPath)).equals(png), true);
        strictEqual(input.workspace.workspace, "henry/project-one");
        return "/home/henry/.t3-coder/attachments/image.png";
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const disconnected = await request({
      url: `${gateway.url}/api/workspaces/project-one/clipboard-image`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "image/png" },
      body: png,
    });
    strictEqual(disconnected.statusCode, 409);

    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    const rejectedOrigin = await request({
      url: `${gateway.url}/api/workspaces/project-one/clipboard-image`,
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "image/png" },
      body: png,
    });
    strictEqual(rejectedOrigin.statusCode, 403);

    const uploaded = await request({
      url: `${gateway.url}/api/workspaces/project-one/clipboard-image`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "image/png" },
      body: png,
    });
    strictEqual(uploaded.statusCode, 200);
    deepStrictEqual(JSON.parse(uploaded.body), {
      path: "/home/henry/.t3-coder/attachments/image.png",
    });
    await NodeFS.access(stagedPath).then(
      () => {
        throw new Error("staged clipboard image still exists");
      },
      () => undefined,
    );

    const invalid = await request({
      url: `${gateway.url}/api/workspaces/project-one/clipboard-image`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "image/png" },
      body: Buffer.from("not a png"),
    });
    strictEqual(invalid.statusCode, 415);
  });

  it("bridges loopback WebSocket RPC messages to helper stdio messages", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let rpcListener: ((message: unknown) => void) | undefined;
    let closeConnection: (() => void) | undefined;
    let closeCount = 0;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    let receiveHelperMessage: ((message: unknown) => void) | undefined;
    const helperMessage = new Promise<unknown>((resolve) => {
      receiveHelperMessage = resolve;
    });
    const connection: CoderHelperConnection = {
      info: helperInfo,
      closed,
      sendRpc: (message) => receiveHelperMessage?.(message),
      onRpcMessage: (listener) => {
        rpcListener = listener;
        return () => {
          rpcListener = undefined;
        };
      },
      close: () => {
        closeCount += 1;
        closeConnection?.();
      },
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => connection,
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });
    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    const rpcUrl = gateway.url.replace("http://", "ws://");
    const webSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(webSocket, "open");
    const requestMessage = { _tag: "Request", id: 7, tag: "test.method", payload: {}, headers: [] };
    webSocket.send(JSON.stringify(requestMessage));
    const forwardedRequest = (await helperMessage) as typeof requestMessage;
    strictEqual(forwardedRequest._tag, "Request");
    strictEqual(forwardedRequest.tag, requestMessage.tag);
    strictEqual(typeof forwardedRequest.id, "string");
    strictEqual(String(forwardedRequest.id).startsWith("browser:"), true);

    const browserMessage = once(webSocket, "message");
    const helperResponseMessage = {
      _tag: "Exit",
      requestId: forwardedRequest.id,
      exit: { _tag: "Success", value: {} },
    };
    rpcListener?.(helperResponseMessage);
    const [data] = await browserMessage;
    const responseMessage = { ...helperResponseMessage, requestId: requestMessage.id };
    deepStrictEqual(JSON.parse(data.toString()), responseMessage);

    const firstStreamMessage = new Promise<unknown>((resolve) => {
      receiveHelperMessage = resolve;
    });
    const reusedRequestMessage = {
      _tag: "Request",
      id: 8,
      tag: "test.stream",
      payload: {},
      headers: [],
    };
    webSocket.send(JSON.stringify(reusedRequestMessage));
    const firstForwardedStream = (await firstStreamMessage) as typeof reusedRequestMessage;
    strictEqual(typeof firstForwardedStream.id, "string");

    const interruptMessage = new Promise<unknown>((resolve) => {
      receiveHelperMessage = resolve;
    });
    const socketClosed = once(webSocket, "close");
    webSocket.close();
    await socketClosed;
    const forwardedInterrupt = (await interruptMessage) as {
      readonly _tag: string;
      readonly requestId: string;
    };
    deepStrictEqual(forwardedInterrupt, {
      _tag: "Interrupt",
      requestId: firstForwardedStream.id,
    });
    rpcListener?.({
      _tag: "Exit",
      requestId: forwardedInterrupt.requestId,
      exit: { _tag: "Failure", cause: { _tag: "Interrupt" } },
    });
    strictEqual(closeCount, 0);

    const nextHelperMessage = new Promise<unknown>((resolve) => {
      receiveHelperMessage = resolve;
    });
    const reconnectedWebSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(reconnectedWebSocket, "open");
    reconnectedWebSocket.send(JSON.stringify(reusedRequestMessage));
    const secondForwardedStream = (await nextHelperMessage) as typeof reusedRequestMessage;
    strictEqual(typeof secondForwardedStream.id, "string");
    strictEqual(secondForwardedStream.id === firstForwardedStream.id, false);

    const reconnectedBrowserMessage = once(reconnectedWebSocket, "message");
    rpcListener?.({
      _tag: "Exit",
      requestId: secondForwardedStream.id,
      exit: { _tag: "Success", value: {} },
    });
    const [reconnectedData] = await reconnectedBrowserMessage;
    deepStrictEqual(JSON.parse(reconnectedData.toString()), {
      _tag: "Exit",
      requestId: reusedRequestMessage.id,
      exit: { _tag: "Success", value: {} },
    });
    const reconnectedSocketClosed = once(reconnectedWebSocket, "close");
    reconnectedWebSocket.close();
    await reconnectedSocketClosed;
    strictEqual(closeCount, 0);
  });

  it("recreates a workspace helper when the helper exits and the browser retries", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    const exitConnections: Array<
      (exit: { code: number; signal: null; expected: boolean }) => void
    > = [];
    let connectCount = 0;
    let probeCount = 0;
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => {
        probeCount += 1;
      },
      connectHelper: async () => {
        connectCount += 1;
        let exitConnection:
          | ((exit: { code: number; signal: null; expected: boolean }) => void)
          | undefined;
        const closed = new Promise<{ code: number; signal: null; expected: boolean }>((resolve) => {
          exitConnection = resolve;
        });
        exitConnections.push((exit) => exitConnection?.(exit));
        return {
          info: helperInfo,
          closed,
          sendRpc: () => undefined,
          onRpcMessage: () => () => undefined,
          close: () => exitConnection?.({ code: 130, signal: null, expected: true }),
        };
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const rpcUrl = gateway.url.replace("http://", "ws://");
    const firstSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(firstSocket, "open");
    strictEqual(connectCount, 1);
    strictEqual(probeCount, 1);

    const firstSocketClosed = once(firstSocket, "close");
    exitConnections[0]?.({ code: 1, signal: null, expected: false });
    await firstSocketClosed;

    const secondSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(secondSocket, "open");
    strictEqual(connectCount, 2);
    strictEqual(probeCount, 2);
    const secondSocketClosed = once(secondSocket, "close");
    secondSocket.close();
    await secondSocketClosed;
  });

  it("reserves a workspace WebSocket slot while the helper connection is starting", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let markConnectStarted: (() => void) | undefined;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const connection: CoderHelperConnection = {
      info: helperInfo,
      closed,
      sendRpc: () => undefined,
      onRpcMessage: () => () => undefined,
      close: () => closeConnection?.(),
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => {
        markConnectStarted?.();
        await connectGate;
        return connection;
      },
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
            workspaceRoot: "/workspace/project-one",
          },
        ],
      }),
    });

    const rpcUrl = gateway.url.replace("http://", "ws://");
    const firstSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    const firstOpened = once(firstSocket, "open");
    await connectStarted;
    const secondSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    secondSocket.on("error", () => undefined);
    const conflictStatus = new Promise<number>((resolve) => {
      secondSocket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
    });
    releaseConnect?.();

    await firstOpened;
    strictEqual(await conflictStatus, 409);
    const firstClosed = once(firstSocket, "close");
    firstSocket.close();
    await firstClosed;
  });

  it("does not wait for a legacy helper that finishes connecting after shutdown", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let releaseConnect: ((connection: CoderHelperConnection) => void) | undefined;
    let markConnectStarted: (() => void) | undefined;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      resolveClosed = () => resolve({ code: 130, signal: null, expected: true });
    });
    let closeCount = 0;
    const connection: CoderHelperConnection = {
      info: helperInfo,
      closed,
      sendRpc: () => undefined,
      onRpcMessage: () => () => undefined,
      close: () => {
        closeCount += 1;
        resolveClosed?.();
      },
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => {
        markConnectStarted?.();
        return await new Promise<CoderHelperConnection>((resolve) => {
          releaseConnect = resolve;
        });
      },
    });
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });

    const connectionRequest = request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    await connectStarted;
    const gatewayClosed = gateway.close();

    await gatewayClosed;
    strictEqual((await connectionRequest).statusCode, 502);
    releaseConnect?.(connection);
    await closed;
    strictEqual(closeCount, 1);
  });

  it("interrupts an Effect-native helper acquisition when the gateway scope closes", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    await NodeFS.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    );
    let markAcquisitionStarted: (() => void) | undefined;
    const acquisitionStarted = new Promise<void>((resolve) => {
      markAcquisitionStarted = resolve;
    });
    let acquisitionFinalized = false;
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const gateway = await Effect.runPromise(
      makeLocalCoderGateway({
        configPath,
        probeWorkspace: () => Effect.void,
        connectHelper: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              markAcquisitionStarted?.();
            }),
            () =>
              Effect.sync(() => {
                acquisitionFinalized = true;
              }),
          ).pipe(Effect.andThen(Effect.never)),
      }).pipe(Scope.provide(scope)),
    );

    const connectionRequest = request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });
    await acquisitionStarted;

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await connectionRequest.catch(() => undefined);

    strictEqual(acquisitionFinalized, true);
  });

  it("finishes an explicit connection close during concurrent gateway shutdown", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    await NodeFS.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "goldman",
            name: "Goldman",
            url: "https://coder.example.gs.com",
          },
        ],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    );
    let markFinalizerStarted: (() => void) | undefined;
    const finalizerStarted = new Promise<void>((resolve) => {
      markFinalizerStarted = resolve;
    });
    let releaseFinalizer: (() => void) | undefined;
    const finalizerReleased = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    let finalizerCompleted = false;
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const gateway = await Effect.runPromise(
      makeLocalCoderGateway({
        configPath,
        probeWorkspace: () => Effect.void,
        connectHelper: () =>
          Effect.acquireRelease(
            Effect.succeed({
              info: helperInfo,
              closed: Effect.never,
              sendRpc: () => Effect.void,
              onRpcMessage: () => () => undefined,
              close: Effect.void,
            }),
            () =>
              Effect.gen(function* () {
                yield* Effect.sync(() => markFinalizerStarted?.());
                yield* Effect.promise(() => finalizerReleased);
                finalizerCompleted = true;
              }),
          ),
      }).pipe(Scope.provide(scope)),
    );
    strictEqual(
      (
        await request({
          url: `${gateway.url}/api/workspaces/project-one/connection`,
          method: "POST",
          headers: { Origin: gateway.url },
        })
      ).statusCode,
      200,
    );

    const connectionClosed = request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "DELETE",
      headers: { Origin: gateway.url },
    });
    await finalizerStarted;
    let gatewayClosed = false;
    const close = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      gatewayClosed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    strictEqual(gatewayClosed, false);

    releaseFinalizer?.();
    await close;
    await connectionClosed.catch(() => undefined);
    strictEqual(finalizerCompleted, true);
  });

  it("clears a pending upgrade after ws rejects invalid handshake headers", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.(),
      }),
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
          },
        ],
      }),
    });
    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    const url = new URL(gateway.url);
    const invalidSocket = NodeNet.createConnection(Number(url.port), url.hostname);
    await once(invalidSocket, "connect");
    const invalidResponse = once(invalidSocket, "data");
    const invalidClosed = once(invalidSocket, "close");
    invalidSocket.write(
      [
        "GET /api/workspaces/project-one/rpc HTTP/1.1",
        `Host: ${url.host}`,
        `Origin: ${gateway.url}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const [responseBytes] = await invalidResponse;
    await invalidClosed;
    strictEqual(responseBytes.toString("utf8").startsWith("HTTP/1.1 400"), true);

    const rpcUrl = gateway.url.replace("http://", "ws://");
    const validSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(validSocket, "open");
    const validClosed = once(validSocket, "close");
    validSocket.close();
    await validClosed;
  });

  it("closes a helper connection removed by a config update", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let closeCount = 0;
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => undefined,
        onRpcMessage: () => () => undefined,
        close: () => {
          closeCount += 1;
          closeConnection?.();
        },
      }),
    });
    closeGateway = gateway.close;
    const deployment = {
      id: "goldman",
      name: "Goldman",
      url: "https://coder.example.gs.com",
    };
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [deployment],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
            workspaceRoot: "/workspace/project-one",
          },
        ],
      }),
    });
    await request({
      url: `${gateway.url}/api/workspaces/project-one/connection`,
      method: "POST",
      headers: { Origin: gateway.url },
    });

    const updated = await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, deployments: [deployment], workspaces: [] }),
    });

    strictEqual(updated.statusCode, 200);
    strictEqual(closeCount, 1);
    deepStrictEqual(
      JSON.parse((await request({ url: `${gateway.url}/api/connections` })).body),
      [],
    );
  });

  it("distinguishes malformed browser RPC from a disconnected helper", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let closeConnection: (() => void) | undefined;
    const closed = new Promise<{ code: number; signal: null; expected: true }>((resolve) => {
      closeConnection = () => resolve({ code: 130, signal: null, expected: true });
    });
    const gateway = await startLocalCoderGateway({
      configPath,
      probeWorkspace: async () => undefined,
      connectHelper: async () => ({
        info: helperInfo,
        closed,
        sendRpc: () => {
          throw new Error("helper disconnected");
        },
        onRpcMessage: () => () => undefined,
        close: () => closeConnection?.(),
      }),
    });
    closeGateway = gateway.close;
    await request({
      url: `${gateway.url}/api/config`,
      method: "POST",
      headers: { Origin: gateway.url, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        deployments: [{ id: "goldman", name: "Goldman", url: "https://coder.example.gs.com" }],
        workspaces: [
          {
            id: "project-one",
            name: "Project One",
            deploymentId: "goldman",
            workspace: "henry/project-one",
            workspaceRoot: "/workspace/project-one",
          },
        ],
      }),
    });

    const rpcUrl = gateway.url.replace("http://", "ws://");
    const malformedSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(malformedSocket, "open");
    const malformedClosed = once(malformedSocket, "close");
    malformedSocket.send("not json");
    const [malformedCode] = await malformedClosed;
    strictEqual(malformedCode, 1007);

    const disconnectedSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(disconnectedSocket, "open");
    const disconnectedClosed = once(disconnectedSocket, "close");
    disconnectedSocket.send(JSON.stringify({ _tag: "Ping" }));
    const [disconnectedCode, disconnectedReason] = await disconnectedClosed;
    strictEqual(disconnectedCode, 1011);
    strictEqual(disconnectedReason.toString(), "Coder workspace disconnected.");
  });
});
