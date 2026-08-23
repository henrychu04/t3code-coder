// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
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
  buildCoderHelperInvocation,
  buildCoderAuthStatusInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderWorkspaceProbeInvocation,
  REMOTE_HELPER_READY_SENTINEL,
  type CoderInvocation,
} from "@t3tools/coder-cli/command";
import {
  connectCoderHelper,
  type CoderHelperConnection,
} from "@t3tools/coder-cli/helperConnection";
import {
  installCoderHelperWithScp,
  uploadCoderClipboardImageWithScp,
} from "@t3tools/coder-cli/scp";
import {
  ClipboardImageValidationError,
  MAX_CLIPBOARD_IMAGE_BYTES,
  validateClipboardImage,
  withStagedClipboardImage,
} from "./clipboardImage.ts";

export const CODER_GATEWAY_HOST = "127.0.0.1";
const MAX_CONFIG_BODY_BYTES = 64 * 1024;
const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CODER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_CODER_PROBE_BYTES = 32 * 1024;
const MAX_CODER_AUTH_STATUS_BYTES = 64 * 1024;
const CODER_PREFLIGHT_SENTINEL = "T3_CODER_PREFLIGHT_OK";
const DEFAULT_CODER_PROBE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 5_000;

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
      "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'",
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
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR") throw cause;
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

class RequestBodyTooLargeError extends Error {}

function readBody(request: NodeHttp.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError("Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
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

export type CoderAuthenticationStatus = "authenticated" | "unauthenticated" | "unavailable";

export function runCoderAuthStatus(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
): Promise<CoderAuthenticationStatus> {
  return new Promise((resolve) => {
    let settled = false;
    let sawUnauthorizedStatus = false;
    let stderr = "";
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const finish = (status: CoderAuthenticationStatus): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
      if (forceKillTimeout !== undefined) NodeTimers.clearTimeout(forceKillTimeout);
      resolve(status);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_CODER_AUTH_STATUS_BYTES);
      if (/\bStatus code 401\b/.test(stderr)) sawUnauthorizedStatus = true;
    });
    child.once("error", () => finish("unavailable"));
    child.once("exit", (code) => {
      if (code === 0) {
        finish("authenticated");
        return;
      }
      finish(sawUnauthorizedStatus ? "unauthenticated" : "unavailable");
    });
    timeout = NodeTimers.setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimeout = NodeTimers.setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, terminationGraceMs);
    }, timeoutMs);
  });
}

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
}

function workspaceConnectionIsCurrent(
  previous: CoderProfileConfig,
  next: CoderProfileConfig,
  workspaceId: string,
): boolean {
  const previousWorkspace = previous.workspaces.find((entry) => entry.id === workspaceId);
  const nextWorkspace = next.workspaces.find((entry) => entry.id === workspaceId);
  if (previousWorkspace === undefined || nextWorkspace === undefined) return false;
  const previousDeployment = previous.deployments.find(
    (entry) => entry.id === previousWorkspace.deploymentId,
  );
  const nextDeployment = next.deployments.find((entry) => entry.id === nextWorkspace.deploymentId);
  return (
    previousDeployment !== undefined &&
    nextDeployment !== undefined &&
    previousWorkspace.deploymentId === nextWorkspace.deploymentId &&
    previousWorkspace.workspace === nextWorkspace.workspace &&
    previousDeployment.url === nextDeployment.url &&
    previousDeployment.executable === nextDeployment.executable
  );
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

function runCoderWorkspaceProbe(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_PROBE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const rejectOnce = (cause: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
      child.kill();
      reject(cause);
    };
    const appendOutput = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (chunk.byteLength >= MAX_CODER_PROBE_BYTES) {
        return chunk.subarray(chunk.byteLength - MAX_CODER_PROBE_BYTES);
      }
      const overflow = current.byteLength + chunk.byteLength - MAX_CODER_PROBE_BYTES;
      return Buffer.concat([overflow > 0 ? current.subarray(overflow) : current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled) stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!settled) stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (cause) => rejectOnce(cause));
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
      const stdoutDetail = stdout.toString("utf8").trim();
      const stderrDetail = stderr.toString("utf8").trim();
      if (code !== 0) {
        const detail = [stdoutDetail, stderrDetail].filter((value) => value.length > 0).join("\n");
        reject(
          new Error(
            `Coder workspace preflight exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
        return;
      }
      const lines = stdout.toString("utf8").split(/\r?\n/u);
      if (!lines.includes(CODER_PREFLIGHT_SENTINEL)) {
        reject(new Error("Coder workspace preflight did not complete successfully."));
        return;
      }
      resolve();
    });
    timeout = NodeTimers.setTimeout(
      () =>
        rejectOnce(
          new Error(
            "Coder workspace preflight timed out. Check that the workspace is running. On first connection, its configured nixpkgs and Nix substituters must be reachable.",
          ),
        ),
      timeoutMs,
    );
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
  readonly workspaceProbeTimeoutMs?: number;
  readonly coderAuthStatusTimeoutMs?: number;
  readonly checkAuthentication?: (
    invocation: CoderInvocation,
  ) => Promise<CoderAuthenticationStatus>;
  readonly installHelper?: typeof installCoderHelperWithScp;
  readonly uploadClipboardImage?: typeof uploadCoderClipboardImageWithScp;
}): Promise<LocalCoderGateway> {
  let profileConfig: CoderProfileConfig = options?.configPath
    ? await loadCoderProfileConfig(options.configPath)
    : emptyCoderProfileConfig();
  const workspaceConnections = new Map<string, CoderHelperConnection>();
  const workspaceConnectionStarts = new Map<string, Promise<CoderHelperConnection>>();
  const workspaceConnectionGenerations = new Map<string, number>();
  const workspaceSockets = new Map<string, WebSocket>();
  const pendingWorkspaceUpgrades = new Set<string>();
  let gatewayClosed = false;
  let gatewayClosePromise: Promise<void> | undefined;
  const deploymentLoginStarts = new Map<string, Promise<void>>();
  let configMutationQueue = Promise.resolve();
  const serializeConfigMutation = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = configMutationQueue.then(mutation);
    configMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const loginToDeployment = (
    deploymentId: string,
    executable: string,
    args: readonly string[],
  ): Promise<void> => {
    const existing = deploymentLoginStarts.get(deploymentId);
    if (existing !== undefined) return existing;
    const start = runCoderLogin(executable, args);
    deploymentLoginStarts.set(deploymentId, start);
    const cleanup = () => {
      if (deploymentLoginStarts.get(deploymentId) === start) {
        deploymentLoginStarts.delete(deploymentId);
      }
    };
    void start.then(cleanup, cleanup);
    return start;
  };
  const openHelper =
    options?.connectHelper ??
    ((invocation: CoderInvocation) =>
      connectCoderHelper(invocation, { readySentinel: REMOTE_HELPER_READY_SENTINEL }));
  const listWorkspaces = options?.listWorkspaces ?? runCoderWorkspaceList;
  const probeWorkspace =
    options?.probeWorkspace ??
    ((invocation: CoderInvocation) =>
      runCoderWorkspaceProbe(invocation, options?.workspaceProbeTimeoutMs));
  const checkAuthentication =
    options?.checkAuthentication ??
    ((invocation: CoderInvocation) =>
      runCoderAuthStatus(invocation, options?.coderAuthStatusTimeoutMs));
  const installHelper = options?.installHelper ?? installCoderHelperWithScp;
  const uploadClipboardImage = options?.uploadClipboardImage ?? uploadCoderClipboardImageWithScp;
  const coderInvocationOptions = (deploymentId: string) => ({
    globalConfig: NodePath.join(
      NodePath.dirname(options?.configPath ?? NodePath.join(process.cwd(), "config.json")),
      "coder-profiles",
      deploymentId,
    ),
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const ensureWorkspaceConnection = async (workspaceId: string): Promise<CoderHelperConnection> => {
    if (gatewayClosed) throw new Error("Coder gateway is closed.");
    const existing = workspaceConnections.get(workspaceId);
    if (existing !== undefined) return existing;
    const pending = workspaceConnectionStarts.get(workspaceId);
    if (pending !== undefined) return pending;

    const generation = workspaceConnectionGenerations.get(workspaceId) ?? 0;
    const startIsCurrent = () =>
      !gatewayClosed && (workspaceConnectionGenerations.get(workspaceId) ?? 0) === generation;
    const assertStartIsCurrent = () => {
      if (!startIsCurrent()) throw new Error("Coder workspace connection was cancelled.");
    };
    const start = (async () => {
      const connectionConfig = profileConfig;
      const workspace = connectionConfig.workspaces.find((entry) => entry.id === workspaceId);
      const deployment =
        workspace === undefined
          ? undefined
          : connectionConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
      if (workspace === undefined || deployment === undefined) {
        throw new Error("Unknown Coder workspace.");
      }
      const invocationOptions = coderInvocationOptions(deployment.id);
      await probeWorkspace(
        buildCoderWorkspaceProbeInvocation(deployment, workspace, invocationOptions),
      );
      assertStartIsCurrent();
      if (options?.helperBundlePath !== undefined) {
        await installHelper({
          deployment,
          workspace,
          helperBundlePath: options.helperBundlePath,
          invocationOptions,
        });
        assertStartIsCurrent();
      }
      const connection = await openHelper(
        buildCoderHelperInvocation(deployment, workspace, invocationOptions),
      );
      if (!startIsCurrent()) {
        connection.close();
        await connection.closed;
        throw new Error("Coder workspace connection was cancelled.");
      }
      if (!workspaceConnectionIsCurrent(connectionConfig, profileConfig, workspaceId)) {
        connection.close();
        throw new Error("Coder workspace configuration changed while connecting.");
      }
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

  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
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
          const savedConfig = await serializeConfigMutation(async () => {
            if (options?.configPath) await saveCoderProfileConfig(options.configPath, nextConfig);
            for (const [workspaceId, connection] of workspaceConnections) {
              if (workspaceConnectionIsCurrent(profileConfig, nextConfig, workspaceId)) continue;
              connection.close();
              workspaceConnections.delete(workspaceId);
              workspaceSockets.get(workspaceId)?.close(1001, "Workspace configuration changed.");
            }
            profileConfig = nextConfig;
            return profileConfig;
          });
          sendText(response, 200, "application/json; charset=utf-8", JSON.stringify(savedConfig));
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
          const login = buildCoderLoginInvocation(
            deployment,
            coderInvocationOptions(deployment.id),
          );
          await loginToDeployment(deploymentId, login.executable, login.args);
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

      const authRoute = request.url?.match(/^\/api\/deployments\/([^/]+)\/auth-status$/);
      if (request.method === "POST" && authRoute !== null && authRoute !== undefined) {
        if (request.headers.origin !== expectedOrigin) {
          sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
          return;
        }
        let deploymentId: string;
        try {
          deploymentId = decodeURIComponent(authRoute[1] ?? "");
        } catch {
          sendText(response, 400, "text/plain; charset=utf-8", "Invalid deployment id.");
          return;
        }
        const deployment = profileConfig.deployments.find((entry) => entry.id === deploymentId);
        if (deployment === undefined) {
          sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder deployment.");
          return;
        }
        const status = await checkAuthentication(
          buildCoderAuthStatusInvocation(deployment, coderInvocationOptions(deployment.id)),
        );
        sendText(response, 200, "application/json; charset=utf-8", JSON.stringify({ status }));
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
          const workspaces = await listWorkspaces(
            buildCoderListWorkspacesInvocation(deployment, coderInvocationOptions(deployment.id)),
          );
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({ workspaces }),
          );
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
          workspaceConnectionGenerations.set(
            workspaceId,
            (workspaceConnectionGenerations.get(workspaceId) ?? 0) + 1,
          );
          const pendingStart = workspaceConnectionStarts.get(workspaceId);
          const connection = workspaceConnections.get(workspaceId);
          connection?.close();
          workspaceConnections.delete(workspaceId);
          if (pendingStart !== undefined) await pendingStart.catch(() => undefined);
          sendText(response, 200, "application/json; charset=utf-8", '{"status":"closed"}');
          return;
        }
      }
      const imageRoute = request.url?.match(/^\/api\/workspaces\/([^/]+)\/clipboard-image$/);
      if (request.method === "POST" && imageRoute !== null && imageRoute !== undefined) {
        if (request.headers.origin !== expectedOrigin) {
          sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
          return;
        }
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(imageRoute[1] ?? "");
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
        if (!workspaceConnections.has(workspaceId)) {
          sendText(response, 409, "text/plain; charset=utf-8", "Coder workspace is not connected.");
          return;
        }
        const contentType = request.headers["content-type"] ?? "";
        try {
          const bytes = await readBody(request, MAX_CLIPBOARD_IMAGE_BYTES);
          const extension = validateClipboardImage(contentType, bytes);
          const path = await withStagedClipboardImage(bytes, extension, (localPath) =>
            uploadClipboardImage({
              deployment,
              workspace,
              localPath,
              extension,
              invocationOptions: coderInvocationOptions(deployment.id),
            }),
          );
          sendText(response, 200, "application/json; charset=utf-8", JSON.stringify({ path }));
        } catch (cause) {
          if (cause instanceof RequestBodyTooLargeError) {
            sendText(response, 413, "text/plain; charset=utf-8", "Clipboard image exceeds 20 MiB.");
            return;
          }
          if (cause instanceof ClipboardImageValidationError) {
            sendText(response, 415, "text/plain; charset=utf-8", cause.message);
            return;
          }
          sendText(
            response,
            502,
            "text/plain; charset=utf-8",
            cause instanceof Error ? cause.message : "Clipboard image upload failed.",
          );
        }
        return;
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
    })().catch(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        sendText(response, 500, "text/plain; charset=utf-8", "Internal server error.");
      }
    });
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
      if (workspaceSockets.has(workspaceId) || pendingWorkspaceUpgrades.has(workspaceId)) {
        rejectWebSocketUpgrade(socket, 409, "Conflict");
        return;
      }
      pendingWorkspaceUpgrades.add(workspaceId);
      let upgradePending = true;
      const cleanupPendingUpgrade = () => {
        if (!upgradePending) return;
        upgradePending = false;
        pendingWorkspaceUpgrades.delete(workspaceId);
        socket.off("close", cleanupPendingUpgrade);
        socket.off("error", cleanupPendingUpgrade);
      };
      socket.once("close", cleanupPendingUpgrade);
      socket.once("error", cleanupPendingUpgrade);

      let helper: CoderHelperConnection;
      try {
        helper = await ensureWorkspaceConnection(workspaceId);
      } catch {
        cleanupPendingUpgrade();
        rejectWebSocketUpgrade(socket, 502, "Bad Gateway");
        return;
      }
      if (socket.destroyed) {
        cleanupPendingUpgrade();
        return;
      }

      try {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          cleanupPendingUpgrade();
          workspaceSockets.set(workspaceId, webSocket);
          const unsubscribe = helper.onRpcMessage((message) => {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
          });
          webSocket.on("message", (data, isBinary) => {
            if (isBinary) {
              webSocket.close(1003, "Text RPC messages required.");
              return;
            }
            let message: unknown;
            try {
              message = JSON.parse(data.toString("utf8")) as unknown;
            } catch {
              webSocket.close(1007, "Invalid RPC message.");
              return;
            }
            try {
              helper.sendRpc(message);
            } catch {
              webSocket.close(1011, "Coder workspace disconnected.");
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
              webSocket.close(
                exit.expected ? 1001 : 1011,
                exit.reason ?? "Coder workspace disconnected.",
              );
            }
          });
        });
      } catch (cause) {
        cleanupPendingUpgrade();
        throw cause;
      }
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
    close: () => {
      gatewayClosePromise ??= (async () => {
        gatewayClosed = true;
        for (const webSocket of workspaceSockets.values()) {
          webSocket.close(1001, "Gateway stopped.");
        }
        workspaceSockets.clear();
        pendingWorkspaceUpgrades.clear();
        const connectionClosures = [...workspaceConnections.values()].map((connection) => {
          connection.close();
          return connection.closed;
        });
        workspaceConnections.clear();
        await Promise.allSettled([...workspaceConnectionStarts.values()]);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all(connectionClosures);
        webSocketServer.close();
      })();
      return gatewayClosePromise;
    },
  };
}
