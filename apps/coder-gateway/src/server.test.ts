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
        "--disable-network-telemetry",
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
    let receivedArgs: readonly string[] = [];
    const connection: CoderHelperConnection = {
      info: helperInfo,
      closed,
      sendRpc: () => undefined,
      onRpcMessage: () => () => undefined,
      close: () => closeConnection?.({ code: 130, signal: null, expected: true }),
    };
    const gateway = await startLocalCoderGateway({
      configPath,
      connectHelper: async (invocation) => {
        receivedArgs = invocation.args;
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
          workspaceRoot: "/workspace/project-one",
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
    deepStrictEqual(receivedArgs, [
      "--disable-network-telemetry",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "henry/project-one",
      "--",
      "env",
      "'T3_CODER_CWD=/workspace/project-one'",
      '"$HOME/.t3-coder/bin/workspace-helper"',
      "--stdio",
    ]);
  });

  it("bridges loopback WebSocket RPC messages to helper stdio messages", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-gateway-"));
    tempDirectories.push(directory);
    const configPath = NodePath.join(directory, "config.json");
    let rpcListener: ((message: unknown) => void) | undefined;
    let closeConnection: (() => void) | undefined;
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
      close: () => closeConnection?.(),
    };
    const gateway = await startLocalCoderGateway({
      configPath,
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
  });
});
