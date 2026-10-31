import type {
  DiscoveredCoderWorkspace,
  WorkspaceDiagnosticPhase,
  WorkspaceDiagnosticEvent,
} from "@t3tools/contracts";
export type {
  DiscoveredCoderWorkspace,
  WorkspaceDiagnosticPhase,
  WorkspaceDiagnosticEvent,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { WebSocket, WebSocketServer } from "ws";

import {
  emptyCoderProfileConfig,
  loadCoderProfileConfig,
  parseCoderProfileConfig,
  saveCoderProfileConfig,
  type CoderProfileConfig,
} from "@t3tools/coder-cli/configStore";
import {
  buildCoderPortForwardInvocation,
  buildCoderHelperInvocation,
  buildCoderAuthStatusInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderRestartWorkspaceInvocation,
  buildCoderStartWorkspaceInvocation,
  buildCoderStopWorkspaceInvocation,
  buildCoderUpdateWorkspaceInvocation,
  REMOTE_HELPER_READY_SENTINEL,
  type CoderInvocation,
} from "@t3tools/coder-cli/command";
import {
  CoderHelperInstallRequiredError,
  connectCoderHelper,
  type CoderHelperConnection,
} from "@t3tools/coder-cli/helperConnection";
import {
  connectCoderPortForward,
  type CoderPortForwardConnection,
} from "@t3tools/coder-cli/portForward";
import { CODER_RPC_FRAME_MAX_BYTES } from "@t3tools/coder-cli/rpc";
import { hashCoderHelperBundle, installCoderHelper } from "@t3tools/coder-cli/transfer";
import {
  MAX_FORWARDED_UPLOAD_BYTES,
  proxyWorkspaceAsset,
  WORKSPACE_ASSET_ROUTE,
  WORKSPACE_UPLOAD_ROUTE,
} from "./assetProxy.ts";
import { GatewayProcessError, runGatewayProcess } from "./process.ts";
import {
  makeWorkspaceRpcBridge,
  RpcBridgeSessionError,
  type RpcBridgeSession,
  type WorkspaceRpcBridge,
} from "./rpcBridge.ts";
import { makeCoderHub } from "./hub.ts";

export const CODER_GATEWAY_HOST = "127.0.0.1";
const MAX_CONFIG_BODY_BYTES = 64 * 1024;
const MAX_CODER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_CODER_AUTH_STATUS_BYTES = 64 * 1024;
const MAX_CODER_WORKSPACE_ACTION_BYTES = 64 * 1024;
const MAX_WORKSPACE_DIAGNOSTIC_EVENTS = 24;
const DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CODER_WORKSPACE_LIST_TIMEOUT_MS = 30_000;

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
  cacheHeaders: Readonly<Record<string, string>> = { "Cache-Control": "no-store" },
): void {
  response.writeHead(statusCode, {
    ...cacheHeaders,
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' 'sha256-n0OPhj7RDHbzPYmNVtzBFHdU5YSjXCbQBVoFS8BcmDQ='; connect-src 'self' blob: https: http: ws://127.0.0.1:*; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; worker-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:",
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

/**
 * Build outputs named in Vite's manifest, which carry a content hash. Like upstream's static
 * route, only these are cached as immutable: a hash-like name alone is not enough.
 */
async function readImmutableBuildAssets(staticDir: string): Promise<ReadonlySet<string>> {
  try {
    const manifest = JSON.parse(
      await NodeFS.readFile(NodePath.join(staticDir, ".vite", "manifest.json"), "utf8"),
    ) as Record<string, { file?: unknown; css?: unknown; assets?: unknown }>;
    const files = Object.values(manifest).flatMap((entry) => [
      entry.file,
      ...(Array.isArray(entry.css) ? entry.css : []),
      ...(Array.isArray(entry.assets) ? entry.assets : []),
    ]);
    return new Set(files.filter((file): file is string => typeof file === "string"));
  } catch {
    return new Set();
  }
}

async function serveStaticFile(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  staticDir: string,
  pathname: string,
  immutableBuildAssets: ReadonlySet<string>,
): Promise<boolean> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = NodePath.resolve(staticDir, relativePath);
  const root = `${NodePath.resolve(staticDir)}${NodePath.sep}`;
  if (!candidate.startsWith(root)) return false;
  try {
    const info = await NodeFS.stat(candidate);
    if (!info.isFile()) return false;
    const extension = NodePath.extname(candidate);
    const contentType = STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream";
    // HTML names the current bundle, so it is always revalidated in full.
    if (extension === ".html") {
      sendText(response, 200, contentType, await NodeFS.readFile(candidate), {
        "Cache-Control": "no-cache",
      });
      return true;
    }
    const assetPath = NodePath.relative(staticDir, candidate).replaceAll("\\", "/");
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const cacheHeaders = {
      "Cache-Control": immutableBuildAssets.has(assetPath)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ETag: etag,
    };
    const ifNoneMatch = request.headers["if-none-match"];
    if (
      ifNoneMatch !== undefined &&
      ifNoneMatch
        .split(",")
        .some(
          (value) => value.trim() === "*" || value.trim().replace(/^W\//i, "") === etag.slice(2),
        )
    ) {
      response.writeHead(304, cacheHeaders);
      response.end();
      return true;
    }
    sendText(response, 200, contentType, await NodeFS.readFile(candidate), cacheHeaders);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR") throw cause;
    return false;
  }
}

/** Ports past the requested one a server forward tries before reporting that none is free. */
const MAX_LOCAL_PORT_CANDIDATES = 100;

/** Whether `port` can be bound on the loopback address `coder port-forward` listens on. */
function loopbackPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = NodeHttp.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: CODER_GATEWAY_HOST, exclusive: true }, () =>
      probe.close(() => resolve(true)),
    );
  });
}

/**
 * The requested port, or the next one, that no saved TCP forward uses and nothing on this
 * computer holds. Null when none of the candidates is free.
 */
async function findFreeForwardPort(
  requested: number,
  config: CoderProfileConfig,
): Promise<number | null> {
  const saved = new Set(
    (config.portForwards ?? [])
      .filter((portForward) => portForward.protocol === "tcp")
      .map((portForward) => portForward.localPort),
  );
  const last = Math.min(65_535, requested + MAX_LOCAL_PORT_CANDIDATES);
  for (let port = requested; port <= last; port += 1) {
    if (!saved.has(port) && (await loopbackPortIsFree(port))) return port;
  }
  return null;
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

function isServerNotRunningError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ERR_SERVER_NOT_RUNNING"
  );
}

const runCoderLogin = Effect.fn("coderGateway.runCoderLogin")(function* (
  executable: string,
  args: readonly string[],
) {
  const result = yield* runGatewayProcess(
    { executable, args },
    {
      label: "Coder login",
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: false,
    },
  );
  if (result.code !== 0) {
    return yield* Effect.fail(
      new GatewayProcessError(
        `Coder login exited with code ${String(result.code)} (${String(result.signal)}).`,
      ),
    );
  }
});

export type CoderAuthenticationStatus = "authenticated" | "unauthenticated" | "unavailable";

function checkCoderAuthStatus(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
): Effect.Effect<CoderAuthenticationStatus> {
  return runGatewayProcess(invocation, {
    label: "Coder authentication check",
    timeoutMs,
    terminationGraceMs,
    stdout: "ignore",
    stderrMode: "tail",
    maxStderrBytes: MAX_CODER_AUTH_STATUS_BYTES,
  }).pipe(
    Effect.map((result): CoderAuthenticationStatus => {
      if (result.code === 0) return "authenticated";
      return /\bStatus code 401\b/.test(result.stderr.toString("utf8"))
        ? "unauthenticated"
        : "unavailable";
    }),
    Effect.catch(() => Effect.succeed("unavailable" as const)),
  );
}

export function runCoderAuthStatus(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
): Promise<CoderAuthenticationStatus> {
  return Effect.runPromise(checkCoderAuthStatus(invocation, timeoutMs, terminationGraceMs));
}

class CoderConfigConflictError extends Error {}

/**
 * Coder keeps a deployment's sign-in in the profile directory named by its id, so a saved
 * deployment's URL never changes; otherwise its session would go to the new host.
 */
function assertDeploymentUrlsUnchanged(previous: CoderProfileConfig, next: CoderProfileConfig) {
  for (const deployment of next.deployments) {
    const saved = previous.deployments.find((entry) => entry.id === deployment.id);
    if (saved !== undefined && saved.url !== deployment.url)
      throw new CoderConfigConflictError(
        `The domain of ${saved.name} cannot change. Add the new domain instead.`,
      );
  }
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

function portForwardIsCurrent(
  previous: CoderProfileConfig,
  next: CoderProfileConfig,
  portForwardId: string,
): boolean {
  const previousPortForward = previous.portForwards?.find((entry) => entry.id === portForwardId);
  const nextPortForward = next.portForwards?.find((entry) => entry.id === portForwardId);
  return (
    previousPortForward !== undefined &&
    nextPortForward !== undefined &&
    previousPortForward.workspaceId === nextPortForward.workspaceId &&
    previousPortForward.protocol === nextPortForward.protocol &&
    previousPortForward.localPort === nextPortForward.localPort &&
    previousPortForward.remotePort === nextPortForward.remotePort &&
    workspaceConnectionIsCurrent(previous, next, previousPortForward.workspaceId)
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
  const latestBuild =
    typeof record.latest_build === "object" &&
    record.latest_build !== null &&
    !Array.isArray(record.latest_build)
      ? (record.latest_build as Record<string, unknown>)
      : undefined;
  const rawStatus = latestBuild?.status;
  const status =
    rawStatus === "running" || rawStatus === "starting" || rawStatus === "stopped"
      ? rawStatus
      : "unknown";
  if (name.length === 0) return null;
  const health =
    typeof record.health === "object" && record.health !== null && !Array.isArray(record.health)
      ? (record.health as Record<string, unknown>)
      : undefined;
  const rawDeadline = latestBuild?.deadline;
  const deadlineMs = typeof rawDeadline === "string" ? Date.parse(rawDeadline) : Number.NaN;
  const rawMaxDeadline = latestBuild?.max_deadline;
  const maxDeadlineMs =
    typeof rawMaxDeadline === "string" ? Date.parse(rawMaxDeadline) : Number.NaN;
  const activeStartBuild =
    latestBuild?.transition === "start" && (status === "running" || status === "starting");
  const autostopAt =
    activeStartBuild && Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
  return {
    name,
    target: owner.length === 0 ? name : `${owner}/${name}`,
    status,
    updateAvailable: record.outdated === true,
    healthy: typeof health?.healthy === "boolean" ? health.healthy : null,
    autostopAt,
    requiredStopAt:
      autostopAt !== null && Number.isFinite(maxDeadlineMs)
        ? new Date(maxDeadlineMs).toISOString()
        : null,
  };
}

function discoveredWorkspaceMatches(
  discovered: DiscoveredCoderWorkspace,
  workspace: { readonly workspace: string },
): boolean {
  return (
    discovered.target === workspace.workspace ||
    (!workspace.workspace.includes("/") && discovered.name === workspace.workspace)
  );
}

/** Fails once `signal` aborts; racing it interrupts the other effect, which stops its child. */
function failWhenAborted(signal: AbortSignal): Effect.Effect<never, Error> {
  return Effect.callback<never, Error>((resume) => {
    const onAbort = () =>
      resume(Effect.fail(new Error("Coder workspace connection was cancelled.")));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function runCoderWorkspaceList(
  invocation: CoderInvocation,
): Effect.Effect<readonly DiscoveredCoderWorkspace[], GatewayProcessError, never> {
  return runGatewayProcess(invocation, {
    label: "Coder workspace discovery",
    timeoutMs: DEFAULT_CODER_WORKSPACE_LIST_TIMEOUT_MS,
    maxStdoutBytes: MAX_CODER_LIST_BYTES,
    maxStderrBytes: MAX_CODER_LIST_BYTES,
    stdoutMode: "error",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0) {
        const detail = result.stderr.toString("utf8").trim();
        return Effect.fail(
          new GatewayProcessError(
            `Coder workspace discovery exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
      }
      return Effect.try({
        try: () => {
          const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
          if (!Array.isArray(parsed)) throw new Error("Coder returned a non-array workspace list.");
          return parsed
            .map(discoveredWorkspace)
            .filter((workspace): workspace is DiscoveredCoderWorkspace => workspace !== null);
        },
        catch: (cause) =>
          new GatewayProcessError(
            cause instanceof Error ? cause.message : "Coder returned an invalid workspace list.",
            { cause },
          ),
      });
    }),
  );
}

function runCoderWorkspaceAction(
  invocation: CoderInvocation,
  action: WorkspaceAction,
): Effect.Effect<void, GatewayProcessError> {
  return runGatewayProcess(invocation, {
    label: `Coder workspace ${action}`,
    maxStdoutBytes: MAX_CODER_WORKSPACE_ACTION_BYTES,
    maxStderrBytes: MAX_CODER_WORKSPACE_ACTION_BYTES,
    stdoutMode: "tail",
    stderrMode: "tail",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.void;
      const detail = [result.stdout, result.stderr]
        .map((output) => output.toString("utf8").trim())
        .filter((output) => output.length > 0)
        .join("\n");
      return Effect.fail(
        new GatewayProcessError(
          `Coder workspace ${action} exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
        ),
      );
    }),
  );
}

type WorkspaceAction = "start" | "stop" | "restart" | "update";

class WorkspaceActionConflictError extends Error {}

interface DeferredPromise<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (cause: unknown) => void;
}

function makeDeferredPromise<A>(): DeferredPromise<A> {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type WorkspaceLifecycleState =
  | {
      readonly _tag: "ShutdownFailed";
      readonly generation: number;
      readonly connection: CoderHelperConnection;
      readonly scope: Scope.Closeable;
      readonly error: string;
    }
  | { readonly _tag: "Disconnected"; readonly generation: number }
  | {
      readonly _tag: "Connecting";
      readonly generation: number;
      readonly operation: Promise<WorkspaceConnection>;
      // Interrupts the attempt, killing its `coder ssh` child, so a close need not wait for it.
      readonly cancel: AbortController;
    }
  | {
      readonly _tag: "Connected";
      readonly generation: number;
      readonly connection: CoderHelperConnection;
      readonly rpcBridge: WorkspaceRpcBridge;
      readonly scope: Scope.Closeable;
    }
  | {
      readonly _tag: "Changing";
      readonly generation: number;
      readonly action: WorkspaceAction;
      readonly operation: Promise<void>;
      // Acquisition cleanup can fail while this operation is waiting for it.
      readonly shutdownFailure?:
        | Extract<WorkspaceLifecycleState, { _tag: "ShutdownFailed" }>
        | undefined;
    };

type PortForwardLifecycleState =
  | {
      readonly _tag: "ShutdownFailed";
      readonly generation: number;
      readonly connection: CoderPortForwardConnection;
      readonly scope: Scope.Closeable;
      readonly error: string;
    }
  | { readonly _tag: "Idle"; readonly generation: number }
  | { readonly _tag: "WorkspaceStopped"; readonly generation: number }
  | {
      readonly _tag: "Starting";
      readonly generation: number;
      readonly operation: Promise<CoderPortForwardConnection>;
    }
  | {
      readonly _tag: "Running";
      readonly generation: number;
      readonly connection: CoderPortForwardConnection;
      readonly scope: Scope.Closeable;
    }
  | {
      readonly _tag: "Stopping";
      readonly generation: number;
      readonly operation: Promise<void>;
      // Acquisition cleanup can fail while this operation is waiting for it.
      readonly shutdownFailure?:
        | Extract<PortForwardLifecycleState, { _tag: "ShutdownFailed" }>
        | undefined;
    }
  | { readonly _tag: "Failed"; readonly generation: number; readonly error: string };

type WorkspaceConnectionClaim =
  | { readonly _tag: "ShutdownFailed"; readonly error: string }
  | { readonly _tag: "Existing"; readonly connection: WorkspaceConnection }
  | { readonly _tag: "Pending"; readonly operation: Promise<WorkspaceConnection> }
  | { readonly _tag: "Changing"; readonly operation: Promise<void> }
  | { readonly _tag: "Start"; readonly generation: number };

type WorkspaceCloseClaim =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Changing"; readonly operation: Promise<void> }
  | {
      readonly _tag: "Close";
      readonly pending: Promise<WorkspaceConnection> | undefined;
      readonly cancel: AbortController | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<WorkspaceLifecycleState, { _tag: "Connected" | "ShutdownFailed" }>
        | undefined;
    };

type PortForwardStartClaim =
  | { readonly _tag: "ShutdownFailed"; readonly error: string }
  | { readonly _tag: "Existing"; readonly connection: CoderPortForwardConnection }
  | { readonly _tag: "Pending"; readonly operation: Promise<CoderPortForwardConnection> }
  | { readonly _tag: "Stopping"; readonly operation: Promise<void> }
  | { readonly _tag: "Start"; readonly generation: number };

type PortForwardStopClaim =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Pending"; readonly operation: Promise<void> }
  | {
      readonly _tag: "Stop";
      readonly pending: Promise<CoderPortForwardConnection> | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<PortForwardLifecycleState, { _tag: "Running" | "ShutdownFailed" }>
        | undefined;
    };

type WorkspaceActionClaim =
  | { readonly _tag: "Pending"; readonly operation: Promise<void> }
  | { readonly _tag: "Conflict"; readonly action: WorkspaceAction }
  | {
      readonly _tag: "Start";
      readonly pending: Promise<WorkspaceConnection> | undefined;
      readonly cancel: AbortController | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<WorkspaceLifecycleState, { _tag: "Connected" | "ShutdownFailed" }>
        | undefined;
    };

interface WorkspaceConnection {
  readonly connection: CoderHelperConnection;
  readonly rpcBridge: WorkspaceRpcBridge;
}

export interface LocalCoderGatewayEffectOptions {
  readonly configPath?: string;
  /** Remembers the loopback port so browser storage keeps one origin across restarts. */
  readonly portPath?: string;
  readonly connectHelper?: (
    invocation: CoderInvocation,
    hooks: { readonly onReady: () => void; readonly signal: AbortSignal },
  ) => Effect.Effect<CoderHelperConnection, unknown, Scope.Scope>;
  readonly helperBundlePath?: string;
  readonly staticDir?: string;
  readonly listWorkspaces?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<readonly DiscoveredCoderWorkspace[], unknown>;
  /** Time allowed for the workspace preflight that runs before the helper is ready. */
  readonly workspaceProbeTimeoutMs?: number;
  readonly coderAuthStatusTimeoutMs?: number;
  readonly checkAuthentication?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderAuthenticationStatus, unknown>;
  readonly startWorkspace?: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly stopWorkspace?: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly restartWorkspace?: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly updateWorkspace?: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
  readonly installHelper?: (
    input: Parameters<typeof installCoderHelper>[0],
  ) => Effect.Effect<void, unknown>;
  readonly connectPortForward?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderPortForwardConnection, unknown, Scope.Scope>;
}

const MIN_SAVED_GATEWAY_PORT = 1024;
const MAX_SAVED_GATEWAY_PORT = 65_535;

async function readSavedGatewayPort(portPath: string): Promise<number | null> {
  try {
    const raw = (await NodeFS.readFile(portPath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const port = Number(raw);
    return port >= MIN_SAVED_GATEWAY_PORT && port <= MAX_SAVED_GATEWAY_PORT ? port : null;
  } catch {
    return null;
  }
}

async function saveGatewayPort(portPath: string, port: number): Promise<void> {
  try {
    await NodeFS.mkdir(NodePath.dirname(portPath), { recursive: true });
    await NodeFS.writeFile(portPath, `${port}\n`, "utf8");
  } catch {
    // The next start falls back to an ephemeral port.
  }
}

export function makeLocalCoderGateway(
  options?: LocalCoderGatewayEffectOptions,
): Effect.Effect<{ readonly url: string }, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const gatewayScope = yield* Effect.scope;
    let profileConfig: CoderProfileConfig = options?.configPath
      ? yield* Effect.tryPromise({
          try: () => loadCoderProfileConfig(options.configPath!),
          catch: (cause) => cause,
        })
      : emptyCoderProfileConfig();
    const hub = makeCoderHub({ config: () => profileConfig });
    const fibers = yield* FiberSet.make();
    const runPromise = yield* FiberSet.runtimePromise(fibers)();
    const runFork = yield* FiberSet.runtime(fibers)();
    const workspaceLifecycles = new Map<
      string,
      SynchronizedRef.SynchronizedRef<WorkspaceLifecycleState>
    >();
    const workspaceDiagnosticEvents = new Map<string, WorkspaceDiagnosticEvent[]>();
    const workspaceAttemptCounters = new Map<string, number>();
    let workspaceDiagnosticEventId = 0;
    const workspaceSockets = new Map<string, WebSocket>();
    const pendingWorkspaceUpgrades = new Set<string>();
    const portForwardLifecycles = new Map<
      string,
      SynchronizedRef.SynchronizedRef<PortForwardLifecycleState>
    >();
    let gatewayClosed = false;
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
      const start = runPromise(runCoderLogin(executable, args));
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
      ((
        invocation: CoderInvocation,
        hooks: { readonly onReady: () => void; readonly signal: AbortSignal },
      ) =>
        connectCoderHelper(invocation, {
          readySentinel: REMOTE_HELPER_READY_SENTINEL,
          onReady: hooks.onReady,
          signal: hooks.signal,
          ...(options?.workspaceProbeTimeoutMs === undefined
            ? {}
            : { preflightTimeoutMs: options.workspaceProbeTimeoutMs }),
        }));
    const listWorkspaces = options?.listWorkspaces ?? runCoderWorkspaceList;
    const immutableBuildAssets =
      options?.staticDir === undefined
        ? new Set<string>()
        : yield* Effect.promise(() => readImmutableBuildAssets(options.staticDir!));
    // The bundle is built before the gateway starts and does not change while it runs.
    const helperBundlePath = options?.helperBundlePath;
    const helperBundleHash =
      helperBundlePath === undefined
        ? Effect.succeed(undefined)
        : yield* Effect.cached(
            Effect.tryPromise({
              try: () => hashCoderHelperBundle(helperBundlePath),
              catch: (cause) =>
                new Error("The local workspace helper bundle could not be read.", { cause }),
            }),
          );
    const checkAuthentication =
      options?.checkAuthentication ??
      ((invocation: CoderInvocation) =>
        checkCoderAuthStatus(invocation, options?.coderAuthStatusTimeoutMs));
    const runWorkspaceStart =
      options?.startWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "start"));
    const runWorkspaceStop =
      options?.stopWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "stop"));
    const runWorkspaceRestart =
      options?.restartWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "restart"));
    const runWorkspaceUpdate =
      options?.updateWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "update"));
    const installHelper = options?.installHelper ?? installCoderHelper;
    const openPortForward = options?.connectPortForward ?? connectCoderPortForward;
    const coderInvocationOptions = (deploymentId: string) => ({
      globalConfig: NodePath.join(
        NodePath.dirname(options?.configPath ?? NodePath.join(process.cwd(), "config.json")),
        "coder-profiles",
        deploymentId,
      ),
    });
    const diagnosticEventsFor = (workspaceId: string): WorkspaceDiagnosticEvent[] => {
      const existing = workspaceDiagnosticEvents.get(workspaceId);
      if (existing !== undefined) return existing;
      const created: WorkspaceDiagnosticEvent[] = [];
      workspaceDiagnosticEvents.set(workspaceId, created);
      return created;
    };
    const beginDiagnosticPhase = (
      workspaceId: string,
      attempt: number,
      phase: WorkspaceDiagnosticPhase,
    ) => {
      const startedAt = Date.now();
      const id = ++workspaceDiagnosticEventId;
      const events = diagnosticEventsFor(workspaceId);
      events.push({ id, attempt, phase, status: "running", startedAt });
      if (events.length > MAX_WORKSPACE_DIAGNOSTIC_EVENTS) {
        events.splice(0, events.length - MAX_WORKSPACE_DIAGNOSTIC_EVENTS);
      }
      return (status: "completed" | "failed") => {
        const index = events.findIndex((event) => event.id === id);
        if (index === -1) return;
        events[index] = {
          id,
          attempt,
          phase,
          status,
          startedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      };
    };
    const instrumentDiagnosticPhase = <A, E, R>(
      workspaceId: string,
      attempt: number,
      phase: WorkspaceDiagnosticPhase,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const finish = beginDiagnosticPhase(workspaceId, attempt, phase);
        return effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => finish(Exit.isSuccess(exit) ? "completed" : "failed")),
          ),
        );
      });
    const recordDiagnosticEvent = (
      workspaceId: string,
      attempt: number,
      phase: WorkspaceDiagnosticPhase,
    ) => beginDiagnosticPhase(workspaceId, attempt, phase)("completed");
    const workspaceLifecycle = (workspaceId: string) => {
      const existing = workspaceLifecycles.get(workspaceId);
      if (existing !== undefined) return existing;
      const created = SynchronizedRef.makeUnsafe<WorkspaceLifecycleState>({
        _tag: "Disconnected",
        generation: 0,
      });
      workspaceLifecycles.set(workspaceId, created);
      return created;
    };
    const portForwardLifecycle = (portForwardId: string) => {
      const existing = portForwardLifecycles.get(portForwardId);
      if (existing !== undefined) return existing;
      const created = SynchronizedRef.makeUnsafe<PortForwardLifecycleState>({
        _tag: "Idle",
        generation: 0,
      });
      portForwardLifecycles.set(portForwardId, created);
      return created;
    };
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: CODER_RPC_FRAME_MAX_BYTES,
      perMessageDeflate: false,
    });

    const ensureWorkspaceConnection = async (workspaceId: string): Promise<WorkspaceConnection> => {
      if (gatewayClosed) throw new Error("Coder gateway is closed.");
      const lifecycle = workspaceLifecycle(workspaceId);
      const deferred = makeDeferredPromise<WorkspaceConnection>();
      const cancel = new AbortController();
      const claim = await runPromise(
        SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceConnectionClaim>(
          lifecycle,
          (state) => {
            switch (state._tag) {
              case "ShutdownFailed":
                return [{ _tag: "ShutdownFailed" as const, error: state.error }, state];
              case "Connected":
                return [
                  {
                    _tag: "Existing" as const,
                    connection: { connection: state.connection, rpcBridge: state.rpcBridge },
                  },
                  state,
                ];
              case "Connecting":
                return [{ _tag: "Pending" as const, operation: state.operation }, state];
              case "Changing":
                return [{ _tag: "Changing" as const, operation: state.operation }, state];
              case "Disconnected":
                return [
                  { _tag: "Start" as const, generation: state.generation },
                  {
                    _tag: "Connecting" as const,
                    generation: state.generation,
                    operation: deferred.promise,
                    cancel,
                  },
                ];
            }
          },
        ),
      );
      if (claim._tag === "ShutdownFailed") throw new Error(claim.error);
      if (claim._tag === "Existing") return claim.connection;
      if (claim._tag === "Pending") return claim.operation;
      if (claim._tag === "Changing") {
        await claim.operation;
        return ensureWorkspaceConnection(workspaceId);
      }

      const generation = claim.generation;
      const attempt = (workspaceAttemptCounters.get(workspaceId) ?? 0) + 1;
      workspaceAttemptCounters.set(workspaceId, attempt);
      const startIsCurrent = () => {
        const state = SynchronizedRef.getUnsafe(lifecycle);
        return (
          !gatewayClosed &&
          state._tag === "Connecting" &&
          state.generation === generation &&
          state.operation === deferred.promise
        );
      };
      const assertStartIsCurrent = () => {
        if (!startIsCurrent()) throw new Error("Coder workspace connection was cancelled.");
      };
      void runPromise(
        Effect.gen(function* () {
          const connectionConfig = profileConfig;
          const workspace = connectionConfig.workspaces.find((entry) => entry.id === workspaceId);
          const deployment =
            workspace === undefined
              ? undefined
              : connectionConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
          if (workspace === undefined || deployment === undefined) {
            return yield* Effect.fail(new Error("Unknown Coder workspace."));
          }
          const invocationOptions = coderInvocationOptions(deployment.id);
          const expectedBundleHash = yield* helperBundleHash;
          const helperInvocation = buildCoderHelperInvocation(deployment, workspace, {
            ...invocationOptions,
            ...(expectedBundleHash === undefined ? {} : { expectedBundleHash }),
          });
          const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
          // One `coder ssh` runs the preflight, checks the installed bundle, and starts the helper.
          // The preflight phase ends when the launch prints its ready sentinel.
          const launchHelper = Effect.suspend(() => {
            const finishPreflight = beginDiagnosticPhase(workspaceId, attempt, "preflight");
            let finishNegotiation: ((status: "completed" | "failed") => void) | undefined;
            const onReady = () => {
              if (finishNegotiation !== undefined) return;
              finishPreflight("completed");
              finishNegotiation = beginDiagnosticPhase(workspaceId, attempt, "negotiating_helper");
            };
            return openHelper(helperInvocation, { onReady, signal: cancel.signal }).pipe(
              Scope.provide(connectionScope),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) onReady();
                  if (finishNegotiation !== undefined) {
                    finishNegotiation(Exit.isSuccess(exit) ? "completed" : "failed");
                    return;
                  }
                  const installRequired = Exit.findErrorOption(exit).pipe(
                    Option.exists((error) => error instanceof CoderHelperInstallRequiredError),
                  );
                  finishPreflight(installRequired ? "completed" : "failed");
                }),
              ),
            );
          });
          let acquired: CoderHelperConnection | undefined;
          return yield* Effect.gen(function* () {
            const connection = yield* launchHelper.pipe(
              Effect.catchIf(
                (error) =>
                  error instanceof CoderHelperInstallRequiredError &&
                  helperBundlePath !== undefined,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
                    yield* instrumentDiagnosticPhase(
                      workspaceId,
                      attempt,
                      "installing_helper",
                      installHelper({
                        deployment,
                        workspace,
                        helperBundlePath: helperBundlePath!,
                        invocationOptions,
                      }).pipe(Effect.raceFirst(failWhenAborted(cancel.signal))),
                    );
                    yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
                    return yield* launchHelper;
                  }),
              ),
            );
            acquired = connection;
            runFork(
              connection.closed.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const state = SynchronizedRef.getUnsafe(lifecycle);
                    if (
                      (state._tag === "Connected" || state._tag === "ShutdownFailed") &&
                      state.connection === connection
                    ) {
                      recordDiagnosticEvent(workspaceId, attempt, "disconnected");
                    }
                  }),
                ),
                Effect.tap(() =>
                  SynchronizedRef.update(lifecycle, (state) => {
                    if (
                      state._tag === "Changing" &&
                      state.shutdownFailure?.connection === connection
                    )
                      return { ...state, shutdownFailure: undefined };
                    if (
                      ((state._tag === "Connected" || state._tag === "ShutdownFailed") &&
                        state.connection === connection) ||
                      (state._tag === "Connecting" && state.operation === deferred.promise)
                    )
                      return { _tag: "Disconnected", generation: state.generation } as const;
                    return state;
                  }),
                ),
                Effect.ensuring(Scope.close(connectionScope, Exit.void)),
              ),
            );
            if (!startIsCurrent()) {
              return yield* Effect.fail(new Error("Coder workspace connection was cancelled."));
            }
            if (!workspaceConnectionIsCurrent(connectionConfig, profileConfig, workspaceId)) {
              return yield* Effect.fail(
                new Error("Coder workspace configuration changed while connecting."),
              );
            }
            const rpcBridge = yield* makeWorkspaceRpcBridge(connection).pipe(
              Scope.provide(connectionScope),
            );
            const connected = yield* SynchronizedRef.modify(lifecycle, (state) => {
              if (
                state._tag !== "Connecting" ||
                state.generation !== generation ||
                state.operation !== deferred.promise
              ) {
                return [false, state];
              }
              return [
                true,
                {
                  _tag: "Connected" as const,
                  generation,
                  connection,
                  rpcBridge,
                  scope: connectionScope,
                },
              ];
            });
            if (!connected) {
              return yield* Effect.fail(new Error("Coder workspace connection was cancelled."));
            }
            recordDiagnosticEvent(workspaceId, attempt, "connected");
            // Coder: route hub requests to and from this helper while it is connected.
            const detachFromHub = hub.attach(workspaceId, connection);
            yield* Scope.addFinalizer(connectionScope, Effect.sync(detachFromHub));
            return { connection, rpcBridge } satisfies WorkspaceConnection;
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                if (acquired) {
                  // Keep the scope retriable until the child confirms shutdown.
                  const connection = acquired;
                  yield* connection.close.pipe(
                    Effect.onError(() =>
                      SynchronizedRef.update(lifecycle, (state) => {
                        const failure = {
                          _tag: "ShutdownFailed" as const,
                          generation: state.generation,
                          connection,
                          scope: connectionScope,
                          error:
                            "Coder child shutdown failed. Retry stopping it before reconnecting.",
                        };
                        return state._tag === "Changing"
                          ? { ...state, shutdownFailure: failure }
                          : failure;
                      }),
                    ),
                  );
                }
                yield* Scope.close(connectionScope, Exit.void);
              }),
            ),
          );
        }),
      ).then(deferred.resolve, (cause) => {
        void runPromise(
          SynchronizedRef.update(lifecycle, (state) =>
            state._tag === "Connecting" && state.operation === deferred.promise
              ? ({ _tag: "Disconnected", generation: state.generation } as const)
              : state,
          ),
        ).then(
          () => deferred.reject(cause),
          () => deferred.reject(cause),
        );
      });
      return deferred.promise;
    };

    const closeWorkspaceConnection = async (workspaceId: string): Promise<void> => {
      const lifecycle = workspaceLifecycle(workspaceId);
      const deferred = makeDeferredPromise<void>();
      const claim = await runPromise(
        SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceCloseClaim>(lifecycle, (state) => {
          if (state._tag === "Changing")
            return [{ _tag: "Changing", operation: state.operation }, state];
          const generation = state.generation + 1;
          if (state._tag === "Disconnected")
            return [{ _tag: "Closed" }, { _tag: "Disconnected", generation }];
          return [
            {
              _tag: "Close",
              pending: state._tag === "Connecting" ? state.operation : undefined,
              cancel: state._tag === "Connecting" ? state.cancel : undefined,
              scope:
                state._tag === "Connected" || state._tag === "ShutdownFailed"
                  ? state.scope
                  : undefined,
              previous:
                state._tag === "Connected" || state._tag === "ShutdownFailed" ? state : undefined,
            },
            { _tag: "Changing", generation, action: "stop", operation: deferred.promise },
          ];
        }),
      );
      if (claim._tag === "Closed") return;
      if (claim._tag === "Changing") {
        await claim.operation;
        return closeWorkspaceConnection(workspaceId);
      }
      void (async () => {
        try {
          if (claim.previous) await runPromise(claim.previous.connection.close);
          if (claim.scope)
            await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
          claim.cancel?.abort();
          if (claim.pending)
            await claim.pending.catch((cause) => {
              const state = SynchronizedRef.getUnsafe(lifecycle);
              if (
                state._tag === "ShutdownFailed" ||
                ("shutdownFailure" in state && state.shutdownFailure)
              )
                throw cause;
            });
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Changing" && state.operation === deferred.promise
                ? { _tag: "Disconnected" as const, generation: state.generation }
                : state,
            ),
          );
          recordDiagnosticEvent(
            workspaceId,
            workspaceAttemptCounters.get(workspaceId) ?? 1,
            "disconnected",
          );
          deferred.resolve(undefined);
        } catch (cause) {
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Changing" && state.operation === deferred.promise
                ? (state.shutdownFailure ??
                  (claim.previous
                    ? {
                        ...claim.previous,
                        _tag: "ShutdownFailed" as const,
                        generation: state.generation,
                        error:
                          "Coder child shutdown failed. Retry stopping it before reconnecting.",
                      }
                    : {
                        _tag: "Disconnected" as const,
                        generation: state.generation,
                      }))
                : state,
            ),
          );
          deferred.reject(cause);
        }
      })();
      return deferred.promise;
    };

    const ensurePortForward = async (
      portForwardId: string,
    ): Promise<CoderPortForwardConnection> => {
      if (gatewayClosed) throw new Error("Coder gateway is closed.");
      const lifecycle = portForwardLifecycle(portForwardId);
      const deferred = makeDeferredPromise<CoderPortForwardConnection>();
      const claim = await runPromise(
        SynchronizedRef.modify<PortForwardLifecycleState, PortForwardStartClaim>(
          lifecycle,
          (state) => {
            switch (state._tag) {
              case "ShutdownFailed":
                return [{ _tag: "ShutdownFailed" as const, error: state.error }, state];
              case "Running":
                return [{ _tag: "Existing" as const, connection: state.connection }, state];
              case "Starting":
                return [{ _tag: "Pending" as const, operation: state.operation }, state];
              case "Stopping":
                return [{ _tag: "Stopping" as const, operation: state.operation }, state];
              case "Idle":
              case "WorkspaceStopped":
              case "Failed":
                return [
                  { _tag: "Start" as const, generation: state.generation },
                  {
                    _tag: "Starting" as const,
                    generation: state.generation,
                    operation: deferred.promise,
                  },
                ];
            }
          },
        ),
      );
      if (claim._tag === "ShutdownFailed") throw new Error(claim.error);
      if (claim._tag === "Existing") return claim.connection;
      if (claim._tag === "Pending") return claim.operation;
      if (claim._tag === "Stopping") {
        await claim.operation;
        return ensurePortForward(portForwardId);
      }

      const generation = claim.generation;
      const startIsCurrent = () => {
        const state = SynchronizedRef.getUnsafe(lifecycle);
        return (
          !gatewayClosed &&
          state._tag === "Starting" &&
          state.generation === generation &&
          state.operation === deferred.promise
        );
      };
      void runPromise(
        Effect.gen(function* () {
          const connectionConfig = profileConfig;
          const portForward = connectionConfig.portForwards?.find(
            (entry) => entry.id === portForwardId,
          );
          const workspace = connectionConfig.workspaces.find(
            (entry) => entry.id === portForward?.workspaceId,
          );
          const deployment = connectionConfig.deployments.find(
            (entry) => entry.id === workspace?.deploymentId,
          );
          if (portForward === undefined || workspace === undefined || deployment === undefined) {
            return yield* Effect.fail(new Error("Unknown Coder port forward."));
          }

          const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
          let acquired: CoderPortForwardConnection | undefined;
          return yield* Effect.gen(function* () {
            const connection = yield* openPortForward(
              buildCoderPortForwardInvocation(
                deployment,
                workspace,
                portForward,
                coderInvocationOptions(deployment.id),
              ),
            ).pipe(Scope.provide(connectionScope));
            acquired = connection;
            runFork(
              connection.closed.pipe(
                Effect.tap((exit) =>
                  SynchronizedRef.update(lifecycle, (state) => {
                    if (
                      state._tag === "Stopping" &&
                      state.shutdownFailure?.connection === connection
                    )
                      return { ...state, shutdownFailure: undefined };
                    if (
                      !(
                        (state._tag === "Running" || state._tag === "ShutdownFailed") &&
                        state.connection === connection
                      ) &&
                      !(state._tag === "Starting" && state.operation === deferred.promise)
                    )
                      return state;
                    if (
                      !exit.expected &&
                      !gatewayClosed &&
                      portForwardIsCurrent(connectionConfig, profileConfig, portForwardId)
                    ) {
                      return {
                        _tag: "Failed",
                        generation: state.generation,
                        error: exit.reason ?? "Coder port forward stopped unexpectedly.",
                      } as const;
                    }
                    return { _tag: "Idle", generation: state.generation } as const;
                  }),
                ),
                Effect.ensuring(Scope.close(connectionScope, Exit.void)),
              ),
            );
            if (
              !startIsCurrent() ||
              !portForwardIsCurrent(connectionConfig, profileConfig, portForwardId)
            ) {
              return yield* Effect.fail(new Error("Coder port forward was cancelled."));
            }

            const running = yield* SynchronizedRef.modify(lifecycle, (state) => {
              if (
                state._tag !== "Starting" ||
                state.generation !== generation ||
                state.operation !== deferred.promise
              ) {
                return [false, state];
              }
              return [
                true,
                {
                  _tag: "Running" as const,
                  generation,
                  connection,
                  scope: connectionScope,
                },
              ];
            });
            if (!running) {
              return yield* Effect.fail(new Error("Coder port forward was cancelled."));
            }
            return connection;
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                if (acquired) {
                  // Keep the scope retriable until the child confirms shutdown.
                  const connection = acquired;
                  yield* connection.close.pipe(
                    Effect.onError(() =>
                      SynchronizedRef.update(lifecycle, (state) => {
                        const failure = {
                          _tag: "ShutdownFailed" as const,
                          generation: state.generation,
                          connection,
                          scope: connectionScope,
                          error:
                            "Coder child shutdown failed. Retry stopping it before reconnecting.",
                        };
                        return state._tag === "Stopping"
                          ? { ...state, shutdownFailure: failure }
                          : failure;
                      }),
                    ),
                  );
                }
                yield* Scope.close(connectionScope, Exit.void);
              }),
            ),
          );
        }),
      ).then(deferred.resolve, (cause) => {
        void runPromise(
          SynchronizedRef.update(lifecycle, (state) =>
            state._tag === "Starting" && state.operation === deferred.promise
              ? ({
                  _tag: "Failed",
                  generation: state.generation,
                  error:
                    cause instanceof Error ? cause.message : "Coder port forward failed to start.",
                } as const)
              : state,
          ),
        ).then(
          () => deferred.reject(cause),
          () => deferred.reject(cause),
        );
      });
      return deferred.promise;
    };

    const stopPortForward = async (portForwardId: string): Promise<void> => {
      const lifecycle = portForwardLifecycle(portForwardId);
      const deferred = makeDeferredPromise<void>();
      const claim = await runPromise(
        SynchronizedRef.modify<PortForwardLifecycleState, PortForwardStopClaim>(
          lifecycle,
          (state) => {
            if (state._tag === "Stopping") {
              return [{ _tag: "Pending" as const, operation: state.operation }, state];
            }
            const generation = state.generation + 1;
            if (
              state._tag === "Idle" ||
              state._tag === "WorkspaceStopped" ||
              state._tag === "Failed"
            ) {
              return [{ _tag: "Stopped" as const }, { _tag: "Idle", generation }];
            }
            return [
              {
                _tag: "Stop" as const,
                pending: state._tag === "Starting" ? state.operation : undefined,
                scope:
                  state._tag === "Running" || state._tag === "ShutdownFailed"
                    ? state.scope
                    : undefined,
                previous:
                  state._tag === "Running" || state._tag === "ShutdownFailed" ? state : undefined,
              },
              { _tag: "Stopping", generation, operation: deferred.promise },
            ];
          },
        ),
      );
      if (claim._tag === "Stopped") return;
      if (claim._tag === "Pending") return claim.operation;
      void (async () => {
        try {
          if (claim.previous) await runPromise(claim.previous.connection.close);
          if (claim.scope !== undefined) {
            await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
          }
          if (claim.pending !== undefined)
            await claim.pending.catch((cause) => {
              const state = SynchronizedRef.getUnsafe(lifecycle);
              if (
                state._tag === "ShutdownFailed" ||
                ("shutdownFailure" in state && state.shutdownFailure)
              )
                throw cause;
            });
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Stopping" && state.operation === deferred.promise
                ? ({ _tag: "Idle", generation: state.generation } as const)
                : state,
            ),
          );
          deferred.resolve(undefined);
        } catch (cause) {
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Stopping" && state.operation === deferred.promise
                ? (state.shutdownFailure ??
                  (claim.previous
                    ? {
                        ...claim.previous,
                        _tag: "ShutdownFailed" as const,
                        generation: state.generation,
                        error:
                          "Coder child shutdown failed. Retry stopping it before reconnecting.",
                      }
                    : {
                        _tag: "Failed" as const,
                        generation: state.generation,
                        error: "Coder port forward shutdown failed.",
                      }))
                : state,
            ),
          );
          deferred.reject(cause);
        }
      })();
      return deferred.promise;
    };

    const startConfiguredPortForwards = async (): Promise<void> => {
      if ((profileConfig.portForwards?.length ?? 0) === 0) return;
      const workspacesByDeployment = new Map<
        string,
        readonly DiscoveredCoderWorkspace[] | undefined
      >();
      await Promise.all(
        profileConfig.deployments.map(async (deployment) => {
          try {
            workspacesByDeployment.set(
              deployment.id,
              await runPromise(
                listWorkspaces(
                  buildCoderListWorkspacesInvocation(
                    deployment,
                    coderInvocationOptions(deployment.id),
                  ),
                ),
              ),
            );
          } catch {
            workspacesByDeployment.set(deployment.id, undefined);
          }
        }),
      );
      await Promise.allSettled(
        (profileConfig.portForwards ?? []).map(async (portForward) => {
          const workspace = profileConfig.workspaces.find(
            (entry) => entry.id === portForward.workspaceId,
          );
          const runtime =
            workspace === undefined
              ? undefined
              : workspacesByDeployment
                  .get(workspace.deploymentId)
                  ?.find((entry) => discoveredWorkspaceMatches(entry, workspace));
          if (runtime?.status === "stopped") {
            await runPromise(
              SynchronizedRef.update(
                portForwardLifecycle(portForward.id),
                (state) =>
                  ({
                    _tag: "WorkspaceStopped",
                    generation: state.generation,
                  }) as const,
              ),
            );
            return;
          }
          if (runtime?.status === "starting") {
            await runPromise(
              SynchronizedRef.update(
                portForwardLifecycle(portForward.id),
                (state) =>
                  ({
                    _tag: "Failed",
                    generation: state.generation,
                    error: "Coder workspace is starting.",
                  }) as const,
              ),
            );
            return;
          }
          await ensurePortForward(portForward.id);
        }),
      );
    };

    const runWorkspaceAction = (workspaceId: string, action: WorkspaceAction): Promise<void> => {
      const lifecycle = workspaceLifecycle(workspaceId);
      const deferred = makeDeferredPromise<void>();
      return runPromise(
        SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceActionClaim>(
          lifecycle,
          (state) => {
            if (state._tag === "Changing") {
              return [
                state.action === action
                  ? ({ _tag: "Pending" as const, operation: state.operation } as const)
                  : ({ _tag: "Conflict" as const, action: state.action } as const),
                state,
              ];
            }
            return [
              {
                _tag: "Start" as const,
                pending: state._tag === "Connecting" ? state.operation : undefined,
                cancel: state._tag === "Connecting" ? state.cancel : undefined,
                scope:
                  state._tag === "Connected" || state._tag === "ShutdownFailed"
                    ? state.scope
                    : undefined,
                previous:
                  state._tag === "Connected" || state._tag === "ShutdownFailed" ? state : undefined,
              },
              {
                _tag: "Changing" as const,
                generation: state.generation + 1,
                action,
                operation: deferred.promise,
              },
            ];
          },
        ),
      ).then((claim) => {
        if (claim._tag === "Pending") return claim.operation;
        if (claim._tag === "Conflict") {
          const activeAction =
            claim.action === "start"
              ? "starting"
              : claim.action === "stop"
                ? "stopping"
                : claim.action === "restart"
                  ? "restarting"
                  : "updating";
          throw new WorkspaceActionConflictError(`Coder workspace is already ${activeAction}.`);
        }
        void (async () => {
          let helperClosed = false;
          try {
            const workspace = profileConfig.workspaces.find((entry) => entry.id === workspaceId);
            const deployment =
              workspace === undefined
                ? undefined
                : profileConfig.deployments.find((entry) => entry.id === workspace.deploymentId);
            if (workspace === undefined || deployment === undefined) {
              throw new Error("Unknown Coder workspace.");
            }

            const portForwardIds =
              profileConfig.portForwards
                ?.filter((entry) => entry.workspaceId === workspaceId)
                .map((entry) => entry.id) ?? [];
            workspaceSockets.get(workspaceId)?.close(1012, "Coder workspace state is changing.");
            if (claim.previous) await runPromise(claim.previous.connection.close);
            helperClosed = true;
            if (claim.scope !== undefined) {
              await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
            }
            claim.cancel?.abort();
            if (claim.pending !== undefined)
              await claim.pending.catch((cause) => {
                const state = SynchronizedRef.getUnsafe(lifecycle);
                if (
                  state._tag === "ShutdownFailed" ||
                  ("shutdownFailure" in state && state.shutdownFailure)
                )
                  throw cause;
              });
            await Promise.all(portForwardIds.map(stopPortForward));
            if (gatewayClosed) throw new Error("Coder gateway is closed.");

            const invocationOptions = coderInvocationOptions(deployment.id);
            try {
              if (action === "start") {
                await runPromise(
                  runWorkspaceStart(
                    buildCoderStartWorkspaceInvocation(deployment, workspace, invocationOptions),
                  ),
                );
              } else if (action === "stop") {
                await runPromise(
                  runWorkspaceStop(
                    buildCoderStopWorkspaceInvocation(deployment, workspace, invocationOptions),
                  ),
                );
              } else if (action === "restart") {
                await runPromise(
                  runWorkspaceRestart(
                    buildCoderRestartWorkspaceInvocation(deployment, workspace, invocationOptions),
                  ),
                );
              } else {
                await runPromise(
                  runWorkspaceUpdate(
                    buildCoderUpdateWorkspaceInvocation(deployment, workspace, invocationOptions),
                  ),
                );
              }
            } catch (cause) {
              await Promise.all(
                portForwardIds.map((portForwardId) =>
                  runPromise(
                    SynchronizedRef.update(
                      portForwardLifecycle(portForwardId),
                      (state) =>
                        ({
                          _tag: "Failed",
                          generation: state.generation,
                          error: `Coder workspace ${action} failed. Restart this forward after the workspace recovers.`,
                        }) as const,
                    ),
                  ),
                ),
              );
              throw cause;
            }

            if (gatewayClosed) throw new Error("Coder gateway is closed.");
            if (action === "stop") {
              await Promise.all(
                portForwardIds.map((portForwardId) =>
                  runPromise(
                    SynchronizedRef.update(
                      portForwardLifecycle(portForwardId),
                      (state) =>
                        ({
                          _tag: "WorkspaceStopped",
                          generation: state.generation,
                        }) as const,
                    ),
                  ),
                ),
              );
            } else {
              await Promise.allSettled(
                portForwardIds.map((portForwardId) => ensurePortForward(portForwardId)),
              );
            }
            await runPromise(
              SynchronizedRef.update(lifecycle, (state) =>
                state._tag === "Changing" && state.operation === deferred.promise
                  ? ({ _tag: "Disconnected", generation: state.generation } as const)
                  : state,
              ),
            );
            deferred.resolve(undefined);
          } catch (cause) {
            try {
              await runPromise(
                SynchronizedRef.update(lifecycle, (state) =>
                  state._tag === "Changing" && state.operation === deferred.promise
                    ? (state.shutdownFailure ??
                      (!helperClosed && claim.previous
                        ? {
                            ...claim.previous,
                            _tag: "ShutdownFailed" as const,
                            generation: state.generation,
                            error:
                              "Coder helper shutdown failed. Retry stopping it before reconnecting.",
                          }
                        : ({ _tag: "Disconnected", generation: state.generation } as const)))
                    : state,
                ),
              );
            } finally {
              deferred.reject(cause);
            }
          }
        })();
        return deferred.promise;
      });
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
              [...workspaceLifecycles].flatMap(([workspaceId, lifecycle]) => {
                const state = SynchronizedRef.getUnsafe(lifecycle);
                return state._tag === "Connected"
                  ? [{ workspaceId, info: state.connection.info }]
                  : [];
              }),
            ),
          );
          return;
        }
        const diagnosticsRoute = request.url?.match(/^\/api\/workspaces\/([^/]+)\/diagnostics$/);
        if (
          request.method === "GET" &&
          diagnosticsRoute !== null &&
          diagnosticsRoute !== undefined
        ) {
          let workspaceId: string;
          try {
            workspaceId = decodeURIComponent(diagnosticsRoute[1] ?? "");
          } catch {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid workspace id.");
            return;
          }
          if (!profileConfig.workspaces.some((entry) => entry.id === workspaceId)) {
            sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder workspace.");
            return;
          }
          const lifecycleState = SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId));
          const traffic =
            lifecycleState._tag === "Connected" ? lifecycleState.connection.traffic?.() : undefined;
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({
              events: [...diagnosticEventsFor(workspaceId)],
              ...(traffic === undefined ? {} : { traffic }),
            }),
          );
          return;
        }
        if (request.method === "GET" && request.url === "/api/port-forwards") {
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({
              portForwards: (profileConfig.portForwards ?? []).map((portForward) => {
                const state = SynchronizedRef.getUnsafe(portForwardLifecycle(portForward.id));
                return {
                  id: portForward.id,
                  status:
                    state._tag === "Running"
                      ? "running"
                      : state._tag === "WorkspaceStopped"
                        ? "stopped"
                        : state._tag === "Failed" || state._tag === "ShutdownFailed"
                          ? "error"
                          : "starting",
                  ...(state._tag === "Running" && state.connection.ready?.() === true
                    ? { ready: true }
                    : {}),
                  ...(state._tag === "Failed" || state._tag === "ShutdownFailed"
                    ? { error: state.error }
                    : {}),
                };
              }),
            }),
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
          let nextConfig: ReturnType<typeof parseCoderProfileConfig>;
          try {
            nextConfig = parseCoderProfileConfig(await readJsonBody(request));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Invalid configuration.";
            sendText(response, 400, "text/plain; charset=utf-8", message);
            return;
          }
          try {
            const savedConfig = await serializeConfigMutation(async () => {
              const previousConfig = profileConfig;
              assertDeploymentUrlsUnchanged(previousConfig, nextConfig);
              const stalePortForwardIds = new Set(
                (previousConfig.portForwards ?? [])
                  .filter(
                    (portForward) =>
                      !portForwardIsCurrent(previousConfig, nextConfig, portForward.id),
                  )
                  .map((portForward) => portForward.id),
              );
              for (const workspaceId of workspaceLifecycles.keys()) {
                if (workspaceConnectionIsCurrent(previousConfig, nextConfig, workspaceId)) continue;
                await closeWorkspaceConnection(workspaceId);
                workspaceSockets.get(workspaceId)?.close(1001, "Workspace configuration changed.");
                workspaceLifecycles.delete(workspaceId);
              }
              // Keep configuration and live handles until every requested stop succeeds.
              await Promise.all(
                [...stalePortForwardIds].map((portForwardId) => stopPortForward(portForwardId)),
              );
              if (options?.configPath) await saveCoderProfileConfig(options.configPath, nextConfig);
              profileConfig = nextConfig;
              for (const portForwardId of stalePortForwardIds) {
                portForwardLifecycles.delete(portForwardId);
              }
              await startConfiguredPortForwards();
              return profileConfig;
            });
            sendText(response, 200, "application/json; charset=utf-8", JSON.stringify(savedConfig));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Configuration update failed.";
            sendText(
              response,
              cause instanceof CoderConfigConflictError ? 409 : 502,
              "text/plain; charset=utf-8",
              message,
            );
          }
          return;
        }
        const portForwardRestartRoute = request.url?.match(
          /^\/api\/port-forwards\/([^/]+)\/restart$/,
        );
        if (
          request.method === "POST" &&
          portForwardRestartRoute !== null &&
          portForwardRestartRoute !== undefined
        ) {
          if (request.headers.origin !== expectedOrigin) {
            sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
            return;
          }
          let portForwardId: string;
          try {
            portForwardId = decodeURIComponent(portForwardRestartRoute[1] ?? "");
          } catch {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid port forward id.");
            return;
          }
          if (!profileConfig.portForwards?.some((entry) => entry.id === portForwardId)) {
            sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder port forward.");
            return;
          }
          try {
            await stopPortForward(portForwardId);
            await ensurePortForward(portForwardId);
            sendText(response, 200, "application/json; charset=utf-8", '{"status":"running"}');
          } catch (cause) {
            sendText(
              response,
              502,
              "text/plain; charset=utf-8",
              cause instanceof Error ? cause.message : "Coder port forward failed to restart.",
            );
          }
          return;
        }
        if (request.method === "POST" && request.url === "/api/port-forwards/free-port") {
          if (request.headers.origin !== expectedOrigin) {
            sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
            return;
          }
          if (!request.headers["content-type"]?.startsWith("application/json")) {
            sendText(response, 415, "text/plain; charset=utf-8", "JSON content required.");
            return;
          }
          let requested: unknown;
          try {
            requested = ((await readJsonBody(request)) as { readonly port?: unknown } | null)?.port;
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Invalid request.";
            sendText(response, 400, "text/plain; charset=utf-8", message);
            return;
          }
          if (
            typeof requested !== "number" ||
            !Number.isInteger(requested) ||
            requested < 1 ||
            requested > 65_535
          ) {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid port.");
            return;
          }
          const port = await findFreeForwardPort(requested, profileConfig);
          if (port === null) {
            sendText(
              response,
              409,
              "text/plain; charset=utf-8",
              `No free local port from ${requested} to ${Math.min(65_535, requested + MAX_LOCAL_PORT_CANDIDATES)}.`,
            );
            return;
          }
          sendText(response, 200, "application/json; charset=utf-8", JSON.stringify({ port }));
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
            sendText(
              response,
              200,
              "application/json; charset=utf-8",
              '{"status":"authenticated"}',
            );
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
          const status = await runPromise(
            checkAuthentication(
              buildCoderAuthStatusInvocation(deployment, coderInvocationOptions(deployment.id)),
            ),
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
            const workspaces = await runPromise(
              listWorkspaces(
                buildCoderListWorkspacesInvocation(
                  deployment,
                  coderInvocationOptions(deployment.id),
                ),
              ),
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
              const workspaceConnection = await ensureWorkspaceConnection(workspaceId);
              sendText(
                response,
                200,
                "application/json; charset=utf-8",
                JSON.stringify({ workspaceId, info: workspaceConnection.connection.info }),
              );
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : "Coder connection failed.";
              sendText(response, 502, "text/plain; charset=utf-8", message);
            }
            return;
          }
          if (request.method === "DELETE") {
            await closeWorkspaceConnection(workspaceId);
            sendText(response, 200, "application/json; charset=utf-8", '{"status":"closed"}');
            return;
          }
        }
        const actionRoute = request.url?.match(
          /^\/api\/workspaces\/([^/]+)\/(start|stop|restart|update)$/,
        );
        if (request.method === "POST" && actionRoute !== null && actionRoute !== undefined) {
          if (request.headers.origin !== expectedOrigin) {
            sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
            return;
          }
          let workspaceId: string;
          try {
            workspaceId = decodeURIComponent(actionRoute[1] ?? "");
          } catch {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid workspace id.");
            return;
          }
          if (!profileConfig.workspaces.some((entry) => entry.id === workspaceId)) {
            sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder workspace.");
            return;
          }
          const action = actionRoute[2] as WorkspaceAction;
          try {
            await runWorkspaceAction(workspaceId, action);
            sendText(
              response,
              200,
              "application/json; charset=utf-8",
              JSON.stringify({
                status:
                  action === "start"
                    ? "started"
                    : action === "stop"
                      ? "stopped"
                      : action === "restart"
                        ? "restarted"
                        : "updated",
              }),
            );
          } catch (cause) {
            sendText(
              response,
              cause instanceof WorkspaceActionConflictError ? 409 : 502,
              "text/plain; charset=utf-8",
              cause instanceof Error ? cause.message : `Coder workspace ${action} failed.`,
            );
          }
          return;
        }
        // Coder: a workspace's signed asset and attachment upload URLs, answered by upstream's
        // routes in its helper.
        const assetRoute =
          request.method === "GET" || request.method === "HEAD"
            ? requestUrl.pathname.match(WORKSPACE_ASSET_ROUTE)
            : null;
        const uploadRoute =
          request.method === "POST" ? requestUrl.pathname.match(WORKSPACE_UPLOAD_ROUTE) : null;
        const forwardedRoute = assetRoute ?? uploadRoute;
        if (forwardedRoute !== null) {
          if (uploadRoute !== null && request.headers.origin !== expectedOrigin) {
            sendText(response, 403, "text/plain; charset=utf-8", "Forbidden origin.");
            return;
          }
          let workspaceId: string;
          try {
            workspaceId = decodeURIComponent(forwardedRoute[1] ?? "");
          } catch {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid workspace id.");
            return;
          }
          if (!profileConfig.workspaces.some((entry) => entry.id === workspaceId)) {
            sendText(response, 404, "text/plain; charset=utf-8", "Not found.");
            return;
          }
          // These URLs are minted over a live connection, so a request never starts one: an image
          // re-rendered after the workspace disconnected must not reconnect it.
          const lifecycle = workspaceLifecycles.get(workspaceId);
          const state = lifecycle === undefined ? undefined : SynchronizedRef.getUnsafe(lifecycle);
          if (state?._tag !== "Connected") {
            sendText(response, 503, "text/plain; charset=utf-8", "Workspace is not connected.");
            return;
          }
          let upload: { readonly contentLength: number } | undefined;
          if (uploadRoute !== null) {
            const contentLength = Number(request.headers["content-length"]);
            if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
              sendText(response, 411, "text/plain; charset=utf-8", "Content-Length is required.");
              return;
            }
            if (contentLength > MAX_FORWARDED_UPLOAD_BYTES) {
              sendText(response, 413, "text/plain; charset=utf-8", "Upload is too large.");
              return;
            }
            upload = { contentLength };
          }
          await proxyWorkspaceAsset(
            state.connection,
            request,
            response,
            forwardedRoute[2] ?? "",
            upload,
          );
          return;
        }
        if (request.method === "GET" && options?.staticDir) {
          const staticDir = options.staticDir;
          const serve = (pathname: string) =>
            serveStaticFile(request, response, staticDir, pathname, immutableBuildAssets);
          if (await serve(requestUrl.pathname)) return;
          if (await serve("/")) return;
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

        let workspaceConnection: WorkspaceConnection;
        try {
          workspaceConnection = await ensureWorkspaceConnection(workspaceId);
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
            // ws reports a protocol failure, such as a frame over `maxPayload`, as an `error`
            // event and then closes the socket; without a listener Node would crash the gateway.
            // The `close` listener below does the cleanup.
            webSocket.on("error", () => undefined);
            const { connection: helper, rpcBridge } = workspaceConnection;
            const sessionPromise: Promise<RpcBridgeSession> = runPromise(
              rpcBridge.attach({
                isOpen: () => webSocket.readyState === WebSocket.OPEN,
                send: (encoded) => webSocket.send(encoded),
                close: (code, reason) => webSocket.close(code, reason),
              }),
            );
            void sessionPromise.catch(() => {
              if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.close(1013, "Workspace RPC session is unavailable.");
              }
            });
            // Stop reading browser frames while the helper's stdin is backed up, so a slow helper
            // pushes back on the browser instead of growing the gateway's write buffer.
            let pausedForHelper = false;
            const pauseWhileHelperDrains = () => {
              if (pausedForHelper || !helper.needsDrain()) return;
              pausedForHelper = true;
              webSocket.pause();
              void runPromise(helper.drained).finally(() => {
                pausedForHelper = false;
                if (webSocket.readyState === WebSocket.OPEN) webSocket.resume();
              });
            };
            webSocket.on("message", (data, isBinary) => {
              if (isBinary) {
                webSocket.close(1003, "Text RPC messages required.");
                return;
              }
              const encoded = data.toString("utf8");
              let message: unknown;
              try {
                message = JSON.parse(encoded) as unknown;
              } catch {
                webSocket.close(1007, "Invalid RPC message.");
                return;
              }
              void sessionPromise
                .then((session) => runPromise(session.receive(message)))
                .then(pauseWhileHelperDrains)
                .catch((cause) => {
                  if (webSocket.readyState === WebSocket.OPEN) {
                    const helperDisconnected =
                      cause instanceof RpcBridgeSessionError && cause.kind === "helper";
                    webSocket.close(
                      helperDisconnected ? 1011 : 1002,
                      helperDisconnected
                        ? "Coder workspace disconnected."
                        : "Invalid RPC protocol message.",
                    );
                  }
                });
            });
            webSocket.once("close", () => {
              void sessionPromise
                .then((session) => runPromise(session.close))
                .catch(() => undefined)
                .finally(() => {
                  if (workspaceSockets.get(workspaceId) === webSocket) {
                    workspaceSockets.delete(workspaceId);
                  }
                });
            });
            void runPromise(helper.closed)
              .then((exit) => {
                if (webSocket.readyState === WebSocket.OPEN) {
                  webSocket.close(
                    exit.expected ? 1001 : 1011,
                    exit.reason ?? "Coder workspace disconnected.",
                  );
                }
              })
              .catch(() => undefined);
          });
        } catch (cause) {
          cleanupPendingUpgrade();
          throw cause;
        }
      })().catch(() => {
        if (!socket.destroyed) rejectWebSocketUpgrade(socket, 500, "Internal Server Error");
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        gatewayClosed = true;
        for (const webSocket of workspaceSockets.values()) {
          webSocket.close(1001, "Gateway stopped.");
        }
        workspaceSockets.clear();
        workspaceDiagnosticEvents.clear();
        workspaceAttemptCounters.clear();
        pendingWorkspaceUpgrades.clear();
        yield* FiberSet.clear(fibers);
        const connectionScopes = [
          ...[...workspaceLifecycles.values()].flatMap((lifecycle) => {
            const state = SynchronizedRef.getUnsafe(lifecycle);
            return state._tag === "Connected" || state._tag === "ShutdownFailed"
              ? [state.scope]
              : [];
          }),
          ...[...portForwardLifecycles.values()].flatMap((lifecycle) => {
            const state = SynchronizedRef.getUnsafe(lifecycle);
            return state._tag === "Running" || state._tag === "ShutdownFailed" ? [state.scope] : [];
          }),
        ];
        workspaceLifecycles.clear();
        portForwardLifecycles.clear();
        yield* Effect.forEach(connectionScopes, (scope) => Scope.close(scope, Exit.void), {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Effect.callback<void, never>((resume) => {
          try {
            server.close((cause) =>
              resume(
                cause === undefined || isServerNotRunningError(cause)
                  ? Effect.void
                  : Effect.die(cause),
              ),
            );
          } catch (cause) {
            resume(isServerNotRunningError(cause) ? Effect.void : Effect.die(cause));
          }
        });
        webSocketServer.close();
      }),
    );

    const listen = (port: number) =>
      Effect.callback<void, Error>((resume) => {
        const onError = (cause: Error) => resume(Effect.fail(cause));
        server.once("error", onError);
        server.listen(port, CODER_GATEWAY_HOST, () => {
          server.off("error", onError);
          resume(Effect.void);
        });
        return Effect.sync(() => server.off("error", onError));
      });
    // Browser storage belongs to the gateway origin, so reuse the last port when it is free.
    const savedPort = options?.portPath
      ? yield* Effect.promise(() => readSavedGatewayPort(options.portPath!))
      : null;
    yield* savedPort === null ? listen(0) : listen(savedPort).pipe(Effect.catch(() => listen(0)));

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.fail(new Error("Local gateway did not bind to a TCP port."));
    }
    if (options?.portPath && address.port !== savedPort) {
      yield* Effect.promise(() => saveGatewayPort(options.portPath!, address.port));
    }

    yield* Effect.promise(startConfiguredPortForwards);

    return { url: `http://${CODER_GATEWAY_HOST}:${address.port}` };
  });
}
