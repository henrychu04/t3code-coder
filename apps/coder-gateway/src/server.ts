// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import {
  emptyCoderProfileConfig,
  loadCoderProfileConfig,
  parseCoderProfileConfig,
  saveCoderProfileConfig,
  type CoderProfileConfig,
} from "@t3tools/coder-cli/configStore";
import {
  buildCoderHelperInstallInvocation,
  buildCoderHelperInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderWorkspaceProbeInvocation,
  type CoderInvocation,
} from "@t3tools/coder-cli/command";
import {
  connectCoderHelper,
  type CoderHelperConnection,
} from "@t3tools/coder-cli/helperConnection";
import { installCoderHelper } from "@t3tools/coder-cli/helperInstaller";

export const CODER_GATEWAY_HOST = "127.0.0.1";
const MAX_CONFIG_BODY_BYTES = 64 * 1024;
const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CODER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_CODER_PROBE_BYTES = 32 * 1024;
const CODER_PREFLIGHT_SENTINEL = "T3_CODER_PREFLIGHT_OK";

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>T3 Coder</title>
  </head>
  <body>
    <main>
      <h1>T3 Coder</h1>
      <p>The local gateway is ready.</p>
    </main>
  </body>
</html>`;

function sendText(
  response: NodeHttp.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

async function serveStaticFile(
  response: NodeHttp.ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<boolean> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = NodePath.resolve(staticDir, relativePath);
  const root = `${NodePath.resolve(staticDir)}${NodePath.sep}`;
  if (!candidate.startsWith(root)) return false;
  try {
    const body = await NodeFS.readFile(candidate);
    sendText(
      response,
      200,
      STATIC_CONTENT_TYPES[NodePath.extname(candidate)] ?? "application/octet-stream",
      body,
    );
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return false;
  }
}

export interface LocalCoderGateway {
  readonly url: string;
  readonly close: () => Promise<void>;
}

function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_CONFIG_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (cause) {
        reject(cause);
      }
    });
    request.once("error", reject);
  });
}

function rejectWebSocketUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function runCoderLogin(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Coder login exited with code ${String(code)} (${String(signal)}).`));
    });
  });
}

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
}

function discoveredWorkspace(value: unknown): DiscoveredCoderWorkspace | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const owner =
    typeof record.owner_name === "string"
      ? record.owner_name.trim()
      : typeof record.ownerName === "string"
        ? record.ownerName.trim()
        : "";
  if (name.length === 0) return null;
  return { name, target: owner.length === 0 ? name : `${owner}/${name}` };
}

function runCoderWorkspaceList(
  invocation: CoderInvocation,
): Promise<readonly DiscoveredCoderWorkspace[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CODER_LIST_BYTES) {
        child.kill();
        reject(new Error("Coder workspace list is too large."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_CODER_LIST_BYTES) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Coder workspace discovery exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Coder returned a non-array workspace list.");
        resolve(
          parsed
            .map(discoveredWorkspace)
            .filter((workspace): workspace is DiscoveredCoderWorkspace => workspace !== null),
        );
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

function runCoderWorkspaceProbe(invocation: CoderInvocation): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const rejectOnce = (cause: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(cause);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_CODER_PROBE_BYTES) {
        rejectOnce(new Error("Coder workspace preflight output is too large."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (cause) => rejectOnce(cause));
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new Error(
            `Coder workspace preflight exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
        return;
      }
      const lines = Buffer.concat(stdout).toString("utf8").split(/\r?\n/u);
      if (!lines.includes(CODER_PREFLIGHT_SENTINEL)) {
        reject(new Error("Coder workspace preflight did not complete successfully."));
        return;
      }
      resolve();
    });
  });
}

export async function startLocalCoderGateway(options?: {
  readonly configPath?: string;
  readonly connectHelper?: typeof connectCoderHelper;
  readonly helperBundlePath?: string;
  readonly staticDir?: string;
  readonly listWorkspaces?: (
    invocation: CoderInvocation,
  ) => Promise<readonly DiscoveredCoderWorkspace[]>;
  readonly probeWorkspace?: (invocation: CoderInvocation) => Promise<void>;
}): Promise<LocalCoderGateway> {
  let profileConfig: CoderProfileConfig = options?.configPath
    ? await loadCoderProfileConfig(options.configPath)
    : emptyCoderProfileConfig();
  const workspaceConnections = new Map<string, CoderHelperConnection>();
  const workspaceConnectionStarts = new Map<string, Promise<CoderHelperConnection>>();
  const workspaceSockets = new Map<string, WebSocket>();
  const openHelper = options?.connectHelper ?? connectCoderHelper;
  const listWorkspaces = options?.listWorkspaces ?? runCoderWorkspaceList;
  const probeWorkspace = options?.probeWorkspace ?? runCoderWorkspaceProbe;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const ensureWorkspaceConnection = async (workspaceId: string): Promise<CoderHelperConnection> => {
    const existing = workspaceConnections.get(workspaceId);
    if (existing !== undefined) return existing;
    const pending = workspaceConnectionStarts.get(workspaceId);
    if (pending !== undefined) return pending;

    const start = (async () => {
      const workspace = profileConfig.workspaces.find((entry) => entry.id === workspaceId);
      const deployment =
        workspace === undefined
          ? undefined
          : profileConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
      if (workspace === undefined || deployment === undefined) {
        throw new Error("Unknown Coder workspace.");
      }
      await probeWorkspace(buildCoderWorkspaceProbeInvocation(deployment, workspace));
      if (options?.helperBundlePath !== undefined) {
        await installCoderHelper(
          buildCoderHelperInstallInvocation(deployment, workspace),
          options.helperBundlePath,
        );
      }
      const connection = await openHelper(buildCoderHelperInvocation(deployment, workspace));
      workspaceConnections.set(workspaceId, connection);
      void connection.closed.then(() => {
        if (workspaceConnections.get(workspaceId) === connection) {
          workspaceConnections.delete(workspaceId);
        }
      });
      return connection;
    })();
    workspaceConnectionStarts.set(workspaceId, start);
    try {
      return await start;
    } finally {
      if (workspaceConnectionStarts.get(workspaceId) === start) {
        workspaceConnectionStarts.delete(workspaceId);
      }
    }
  };

  const server = NodeHttp.createServer(async (request, response) => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      sendText(response, 503, "text/plain; charset=utf-8", "Gateway unavailable.");
      return;
    }
    const expectedHost = `${CODER_GATEWAY_HOST}:${address.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    if (request.headers.host !== expectedHost) {
      sendText(response, 421, "text/plain; charset=utf-8", "Misdirected request.");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", expectedOrigin);
    if (request.method === "GET" && request.url === "/healthz") {
      sendText(response, 200, "application/json; charset=utf-8", '{"status":"ok"}');
      return;
    }
    if (request.method === "GET" && request.url === "/api/config") {
      sendText(response, 200, "application/json; charset=utf-8", JSON.stringify(profileConfig));
      return;
    }
    if (request.method === "GET" && request.url === "/api/connections") {
      sendText(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify(
          [...workspaceConnections].map(([workspaceId, connection]) => ({
            workspaceId,
            info: connection.info,
          })),
        ),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/config") {
      if (request.headers.origin !== expectedOrigin) {
        sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        sendText(response, 415, "text/plain; charset=utf-8", "JSON content required.");
        return;
      }
      try {
        const nextConfig = parseCoderProfileConfig(await readJsonBody(request));
        if (options?.configPath) await saveCoderProfileConfig(options.configPath, nextConfig);
        profileConfig = nextConfig;
        sendText(response, 200, "application/json; charset=utf-8", JSON.stringify(profileConfig));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Invalid configuration.";
        sendText(response, 400, "text/plain; charset=utf-8", message);
      }
      return;
    }
    const loginRoute = request.url?.match(/^\/api\/deployments\/([^/]+)\/login$/);
    if (request.method === "POST" && loginRoute !== null && loginRoute !== undefined) {
      if (request.headers.origin !== expectedOrigin) {
        sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
        return;
      }
      let deploymentId: string;
      try {
        deploymentId = decodeURIComponent(loginRoute[1] ?? "");
      } catch {
        sendText(response, 400, "text/plain; charset=utf-8", "Invalid deployment id.");
        return;
      }
      const deployment = profileConfig.deployments.find((entry) => entry.id === deploymentId);
      if (deployment === undefined) {
        sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder deployment.");
        return;
      }
      try {
        const login = buildCoderLoginInvocation(deployment);
        await runCoderLogin(login.executable, login.args);
        sendText(response, 200, "application/json; charset=utf-8", '{"status":"authenticated"}');
      } catch (cause) {
        sendText(
          response,
          502,
          "text/plain; charset=utf-8",
          cause instanceof Error ? cause.message : "Coder login failed.",
        );
      }
      return;
    }
    const workspaceListRoute = request.url?.match(/^\/api\/deployments\/([^/]+)\/workspaces$/);
    if (
      request.method === "POST" &&
      workspaceListRoute !== null &&
      workspaceListRoute !== undefined
    ) {
      if (request.headers.origin !== expectedOrigin) {
        sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
        return;
      }
      let deploymentId: string;
      try {
        deploymentId = decodeURIComponent(workspaceListRoute[1] ?? "");
      } catch {
        sendText(response, 400, "text/plain; charset=utf-8", "Invalid deployment id.");
        return;
      }
      const deployment = profileConfig.deployments.find((entry) => entry.id === deploymentId);
      if (deployment === undefined) {
        sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder deployment.");
        return;
      }
      try {
        const workspaces = await listWorkspaces(buildCoderListWorkspacesInvocation(deployment));
        sendText(response, 200, "application/json; charset=utf-8", JSON.stringify({ workspaces }));
      } catch (cause) {
        sendText(
          response,
          502,
          "text/plain; charset=utf-8",
          cause instanceof Error ? cause.message : "Coder workspace discovery failed.",
        );
      }
      return;
    }
    const connectionRoute = request.url?.match(/^\/api\/workspaces\/([^/]+)\/connection$/);
    if (connectionRoute !== null && connectionRoute !== undefined) {
      if (request.headers.origin !== expectedOrigin) {
        sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
        return;
      }
      let workspaceId: string;
      try {
        workspaceId = decodeURIComponent(connectionRoute[1] ?? "");
      } catch {
        sendText(response, 400, "text/plain; charset=utf-8", "Invalid workspace id.");
        return;
      }
      const workspace = profileConfig.workspaces.find((entry) => entry.id === workspaceId);
      const deployment =
        workspace === undefined
          ? undefined
          : profileConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
      if (workspace === undefined || deployment === undefined) {
        sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder workspace.");
        return;
      }

      if (request.method === "POST") {
        try {
          const connection = await ensureWorkspaceConnection(workspaceId);
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({ workspaceId, info: connection.info }),
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Coder connection failed.";
          sendText(response, 502, "text/plain; charset=utf-8", message);
        }
        return;
      }
      if (request.method === "DELETE") {
        const connection = workspaceConnections.get(workspaceId);
        connection?.close();
        workspaceConnections.delete(workspaceId);
        sendText(response, 200, "application/json; charset=utf-8", '{"status":"closed"}');
        return;
      }
    }
    if (request.method === "GET" && options?.staticDir) {
      if (await serveStaticFile(response, options.staticDir, requestUrl.pathname)) return;
      if (await serveStaticFile(response, options.staticDir, "/")) return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/") {
      sendText(response, 200, "text/html; charset=utf-8", indexHtml);
      return;
    }
    sendText(response, 404, "text/plain; charset=utf-8", "Not found.");
  });

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      const expectedHost = `${CODER_GATEWAY_HOST}:${address.port}`;
      const expectedOrigin = `http://${expectedHost}`;
      if (request.headers.host !== expectedHost || request.headers.origin !== expectedOrigin) {
        rejectWebSocketUpgrade(socket, 403, "Forbidden");
        return;
      }
      const route = request.url?.match(/^\/api\/workspaces\/([^/]+)\/rpc$/);
      if (route === null || route === undefined) {
        rejectWebSocketUpgrade(socket, 404, "Not Found");
        return;
      }
      let workspaceId: string;
      try {
        workspaceId = decodeURIComponent(route[1] ?? "");
      } catch {
        rejectWebSocketUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (!profileConfig.workspaces.some((entry) => entry.id === workspaceId)) {
        rejectWebSocketUpgrade(socket, 404, "Not Found");
        return;
      }
      if (workspaceSockets.has(workspaceId)) {
        rejectWebSocketUpgrade(socket, 409, "Conflict");
        return;
      }

      let helper: CoderHelperConnection;
      try {
        helper = await ensureWorkspaceConnection(workspaceId);
      } catch {
        rejectWebSocketUpgrade(socket, 502, "Bad Gateway");
        return;
      }
      if (socket.destroyed) return;
      if (workspaceSockets.has(workspaceId)) {
        rejectWebSocketUpgrade(socket, 409, "Conflict");
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        workspaceSockets.set(workspaceId, webSocket);
        const unsubscribe = helper.onRpcMessage((message) => {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
        });
        webSocket.on("message", (data, isBinary) => {
          if (isBinary) {
            webSocket.close(1003, "Text RPC messages required.");
            return;
          }
          try {
            helper.sendRpc(JSON.parse(data.toString("utf8")) as unknown);
          } catch {
            webSocket.close(1007, "Invalid RPC message.");
          }
        });
        webSocket.once("close", () => {
          unsubscribe();
          if (workspaceSockets.get(workspaceId) === webSocket) {
            workspaceSockets.delete(workspaceId);
          }
        });
        void helper.closed.then((exit) => {
          if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.close(exit.expected ? 1001 : 1011, "Coder workspace disconnected.");
          }
        });
      });
    })().catch(() => {
      if (!socket.destroyed) rejectWebSocketUpgrade(socket, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, CODER_GATEWAY_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Local gateway did not bind to a TCP port.");
  }

  return {
    url: `http://${CODER_GATEWAY_HOST}:${address.port}`,
    close: async () => {
      for (const webSocket of workspaceSockets.values()) webSocket.close(1001, "Gateway stopped.");
      workspaceSockets.clear();
      const connectionClosures = [...workspaceConnections.values()].map((connection) => {
        connection.close();
        return connection.closed;
      });
      workspaceConnections.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all(connectionClosures);
      webSocketServer.close();
    },
  };
}
