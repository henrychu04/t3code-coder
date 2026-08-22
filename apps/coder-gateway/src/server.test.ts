// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, strictEqual } from "node:assert";
import { once } from "node:events";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "node:test";

import { WebSocket } from "ws";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";

import {
  quotePosixShellArgument,
  REMOTE_WORKSPACE_PROBE_COMMAND,
} from "@t3tools/coder-cli/command";
import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import { CODER_GATEWAY_HOST, startLocalCoderGateway } from "./server.ts";

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

function request(input: {
  readonly url: string;
  readonly host?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}) {
  return new Promise<{ readonly statusCode: number; readonly body: string }>((resolve, reject) => {
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
        return [{ name: "project-one", target: "henry/project-one" }];
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
      workspaces: [{ name: "project-one", target: "henry/project-one" }],
    });
    deepStrictEqual(receivedInvocation, {
      executable: "coder",
      args: [
        "--global-config",
        NodePath.join(directory, "coder-profiles", "goldman"),
        "--disable-network-telemetry",
        "--disable-direct-connections",
        "--url",
        "https://coder.example.gs.com",
        "list",
        "--output",
        "json",
      ],
    });
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
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "henry/project-one",
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
    ]);
    deepStrictEqual(receivedHelperArgs, [
      "--global-config",
      NodePath.join(directory, "coder-profiles", "goldman"),
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "henry/project-one",
      "--",
      "env",
      "'T3_CODER_WORKSPACE_LABEL=Goldman · Project One'",
      '"$HOME/.t3-coder/bin/workspace-helper"',
      "--stdio",
    ]);
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
        return true;
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
    deepStrictEqual(JSON.parse(status.body), { authenticated: true });
    deepStrictEqual(receivedInvocation, {
      executable: "coder",
      args: [
        "--global-config",
        NodePath.join(directory, "coder-profiles", "goldman"),
        "--disable-network-telemetry",
        "--disable-direct-connections",
        "--url",
        "https://coder.example.gs.com",
        "whoami",
      ],
    });
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
    const requestMessage = { _tag: "Ping" };
    webSocket.send(JSON.stringify(requestMessage));
    deepStrictEqual(await helperMessage, requestMessage);

    const browserMessage = once(webSocket, "message");
    const responseMessage = { _tag: "Pong" };
    rpcListener?.(responseMessage);
    const [data] = await browserMessage;
    deepStrictEqual(JSON.parse(data.toString()), responseMessage);

    const socketClosed = once(webSocket, "close");
    webSocket.close();
    await socketClosed;
    strictEqual(closeCount, 0);

    const nextHelperMessage = new Promise<unknown>((resolve) => {
      receiveHelperMessage = resolve;
    });
    const reconnectedWebSocket = new WebSocket(`${rpcUrl}/api/workspaces/project-one/rpc`, {
      origin: gateway.url,
    });
    await once(reconnectedWebSocket, "open");
    const nextRequestMessage = { _tag: "ReconnectPing" };
    reconnectedWebSocket.send(JSON.stringify(nextRequestMessage));
    deepStrictEqual(await nextHelperMessage, nextRequestMessage);
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
