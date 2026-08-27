// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  buildCoderPingWorkspaceInvocation,
  buildCoderRestartWorkspaceInvocation,
  buildCoderStartWorkspaceInvocation,
  buildCoderStopWorkspaceInvocation,
  buildCoderUpdateWorkspaceInvocation,
  buildCoderWorkspaceProbeInvocation,
  buildCoderWorkspaceStatsInvocation,
  REMOTE_HELPER_READY_SENTINEL,
  type CoderInvocation,
} from "@t3tools/coder-cli/command";
import {
  CoderHelperConnectionError,
  connectCoderHelper,
  type CoderHelperConnection,
  type CoderHelperExit,
} from "@t3tools/coder-cli/helperConnection";
import {
  connectCoderPortForward,
  type CoderPortForwardConnection,
  type CoderPortForwardExit,
} from "@t3tools/coder-cli/portForward";
import {
  connectCoderWorkspacePing,
  type CoderWorkspacePingConnection,
} from "@t3tools/coder-cli/workspacePing";
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
import { GatewayProcessError, runGatewayProcess } from "./process.ts";
import {
  makeWorkspaceRpcBridge,
  RpcBridgeSessionError,
  type RpcBridgeSession,
  type WorkspaceRpcBridge,
} from "./rpcBridge.ts";

export const CODER_GATEWAY_HOST = "127.0.0.1";
const MAX_CONFIG_BODY_BYTES = 64 * 1024;
const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CODER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_CODER_PROBE_BYTES = 32 * 1024;
const MAX_CODER_AUTH_STATUS_BYTES = 64 * 1024;
const MAX_CODER_WORKSPACE_ACTION_BYTES = 64 * 1024;
const MAX_CODER_WORKSPACE_STATS_BYTES = 64 * 1024;
const MAX_WORKSPACE_DIAGNOSTIC_EVENTS = 24;
const CODER_PREFLIGHT_SENTINEL = "T3_CODER_PREFLIGHT_OK";
const DEFAULT_CODER_PROBE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CODER_WORKSPACE_STATS_TIMEOUT_MS = 15_000;
const PROMISE_ADAPTER_CLOSE_TIMEOUT_MS = 5_000;

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
      "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' 'sha256-66N88M2Gs4tvXNc8z6k+OKKok8OCKne3d83NpL7KJ9A='; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'",
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

export interface DiscoveredCoderWorkspace {
  readonly name: string;
  readonly target: string;
  readonly status: "running" | "starting" | "stopped" | "unknown";
  readonly updateAvailable: boolean;
  readonly healthy: boolean | null;
  readonly autostopAt: string | null;
}

export interface CoderWorkspaceResourceUsage {
  readonly cpu: { readonly used: number; readonly total: number; readonly unit: "cores" };
  readonly memory: { readonly used: number; readonly total: number; readonly unit: "B" };
  readonly disk: { readonly used: number; readonly total: number; readonly unit: "B" };
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
  return {
    name,
    target: owner.length === 0 ? name : `${owner}/${name}`,
    status,
    updateAvailable: record.outdated === true,
    healthy: typeof health?.healthy === "boolean" ? health.healthy : null,
    autostopAt: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
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

function runCoderWorkspaceList(
  invocation: CoderInvocation,
): Effect.Effect<readonly DiscoveredCoderWorkspace[], GatewayProcessError, never> {
  return runGatewayProcess(invocation, {
    label: "Coder workspace discovery",
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

function runCoderWorkspaceProbe(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_PROBE_TIMEOUT_MS,
): Effect.Effect<void, GatewayProcessError> {
  return runGatewayProcess(invocation, {
    label: "Coder workspace preflight",
    timeoutMs,
    maxStdoutBytes: MAX_CODER_PROBE_BYTES,
    maxStderrBytes: MAX_CODER_PROBE_BYTES,
    stdoutMode: "tail",
    stderrMode: "tail",
  }).pipe(
    Effect.catchTag("GatewayProcessError", (error) =>
      error.message === "Coder workspace preflight timed out."
        ? Effect.fail(
            new GatewayProcessError(
              "Coder workspace preflight timed out. Check that the workspace is running. On first connection, its configured nixpkgs and Nix substituters must be reachable.",
              { cause: error },
            ),
          )
        : Effect.fail(error),
    ),
    Effect.flatMap((result) => {
      const stdoutDetail = result.stdout.toString("utf8").trim();
      const stderrDetail = result.stderr.toString("utf8").trim();
      if (result.code !== 0) {
        const detail = [stdoutDetail, stderrDetail].filter((value) => value.length > 0).join("\n");
        return Effect.fail(
          new GatewayProcessError(
            `Coder workspace preflight exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
      }
      const lines = result.stdout.toString("utf8").split(/\r?\n/u);
      return lines.includes(CODER_PREFLIGHT_SENTINEL)
        ? Effect.void
        : Effect.fail(
            new GatewayProcessError("Coder workspace preflight did not complete successfully."),
          );
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

function parseWorkspaceStat<Unit extends "cores" | "B">(
  value: unknown,
  expectedUnit: Unit,
  label: string,
): { readonly used: number; readonly total: number; readonly unit: Unit } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayProcessError(`Coder returned invalid ${label} usage.`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.used !== "number" ||
    !Number.isFinite(record.used) ||
    record.used < 0 ||
    typeof record.total !== "number" ||
    !Number.isFinite(record.total) ||
    record.total <= 0 ||
    record.unit !== expectedUnit
  ) {
    throw new GatewayProcessError(`Coder returned invalid ${label} usage.`);
  }
  return { used: record.used, total: record.total, unit: expectedUnit };
}

export function parseCoderWorkspaceResourceUsage(output: string): CoderWorkspaceResourceUsage {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new GatewayProcessError("Coder returned invalid workspace resource usage.", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayProcessError("Coder returned invalid workspace resource usage.");
  }
  const record = value as Record<string, unknown>;
  return {
    cpu: parseWorkspaceStat(record.cpu, "cores", "CPU"),
    memory: parseWorkspaceStat(record.memory, "B", "memory"),
    disk: parseWorkspaceStat(record.disk, "B", "disk"),
  };
}

function runCoderWorkspaceResourceUsage(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_WORKSPACE_STATS_TIMEOUT_MS,
): Effect.Effect<CoderWorkspaceResourceUsage, GatewayProcessError> {
  return runGatewayProcess(invocation, {
    label: "Coder workspace resource usage",
    timeoutMs,
    maxStdoutBytes: MAX_CODER_WORKSPACE_STATS_BYTES,
    maxStderrBytes: MAX_CODER_WORKSPACE_STATS_BYTES,
    stdoutMode: "error",
    stderrMode: "tail",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0) {
        const detail = result.stderr.toString("utf8").trim();
        return Effect.fail(
          new GatewayProcessError(
            `Coder workspace resource usage exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
      }
      return Effect.try({
        try: () => parseCoderWorkspaceResourceUsage(result.stdout.toString("utf8")),
        catch: (cause) =>
          cause instanceof GatewayProcessError
            ? cause
            : new GatewayProcessError("Coder returned invalid workspace resource usage.", {
                cause,
              }),
      });
    }),
  );
}

type WorkspaceAction = "start" | "stop" | "restart" | "update";

export type WorkspaceDiagnosticPhase =
  | "preflight"
  | "installing_helper"
  | "negotiating_helper"
  | "connected"
  | "disconnected";

export interface WorkspaceDiagnosticEvent {
  readonly id: number;
  readonly attempt: number;
  readonly phase: WorkspaceDiagnosticPhase;
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: number;
  readonly durationMs?: number;
}

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
  | { readonly _tag: "Disconnected"; readonly generation: number }
  | {
      readonly _tag: "Connecting";
      readonly generation: number;
      readonly operation: Promise<WorkspaceConnection>;
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
    };

type PortForwardLifecycleState =
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
    }
  | { readonly _tag: "Failed"; readonly generation: number; readonly error: string };

type WorkspaceConnectionClaim =
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
      readonly scope: Scope.Closeable | undefined;
    };

type PortForwardStartClaim =
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
    };

type WorkspaceActionClaim =
  | { readonly _tag: "Pending"; readonly operation: Promise<void> }
  | { readonly _tag: "Conflict"; readonly action: WorkspaceAction }
  | {
      readonly _tag: "Start";
      readonly pending: Promise<WorkspaceConnection> | undefined;
      readonly scope: Scope.Closeable | undefined;
    };

interface WorkspaceConnection {
  readonly connection: CoderHelperConnection;
  readonly rpcBridge: WorkspaceRpcBridge;
}

export interface LocalCoderGatewayEffectOptions {
  readonly configPath?: string;
  readonly connectHelper?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderHelperConnection, unknown, Scope.Scope>;
  readonly helperBundlePath?: string;
  readonly staticDir?: string;
  readonly listWorkspaces?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<readonly DiscoveredCoderWorkspace[], unknown>;
  readonly probeWorkspace?: (invocation: CoderInvocation) => Effect.Effect<void, unknown>;
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
    input: Parameters<typeof installCoderHelperWithScp>[0],
  ) => Effect.Effect<void, unknown>;
  readonly uploadClipboardImage?: (
    input: Parameters<typeof uploadCoderClipboardImageWithScp>[0],
  ) => Effect.Effect<string, unknown>;
  readonly connectPortForward?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderPortForwardConnection, unknown, Scope.Scope>;
  readonly connectWorkspacePing?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderWorkspacePingConnection, unknown, Scope.Scope>;
  readonly readWorkspaceResourceUsage?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderWorkspaceResourceUsage, unknown>;
  readonly workspaceResourceUsageTimeoutMs?: number;
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
    const workspacePings = new Map<
      string,
      {
        readonly connection: CoderWorkspacePingConnection;
        readonly helper: CoderHelperConnection;
      }
    >();
    const workspacePingStarts = new Map<string, Promise<CoderWorkspacePingConnection>>();
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
        checkCoderAuthStatus(invocation, options?.coderAuthStatusTimeoutMs));
    const runWorkspaceStart =
      options?.startWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "start"));
    const runWorkspaceStop =
      options?.stopWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "stop"));
    const runWorkspaceRestart =
      options?.restartWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "restart"));
    const runWorkspaceUpdate =
      options?.updateWorkspace ?? ((invocation) => runCoderWorkspaceAction(invocation, "update"));
    const installHelper = options?.installHelper ?? installCoderHelperWithScp;
    const uploadClipboardImage = options?.uploadClipboardImage ?? uploadCoderClipboardImageWithScp;
    const openPortForward = options?.connectPortForward ?? connectCoderPortForward;
    const openWorkspacePing = options?.connectWorkspacePing ?? connectCoderWorkspacePing;
    const readWorkspaceResourceUsage =
      options?.readWorkspaceResourceUsage ??
      ((invocation: CoderInvocation) =>
        runCoderWorkspaceResourceUsage(invocation, options?.workspaceResourceUsageTimeoutMs));
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
      maxPayload: MAX_RPC_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    const ensureWorkspaceConnection = async (workspaceId: string): Promise<WorkspaceConnection> => {
      if (gatewayClosed) throw new Error("Coder gateway is closed.");
      const lifecycle = workspaceLifecycle(workspaceId);
      const deferred = makeDeferredPromise<WorkspaceConnection>();
      const claim = await runPromise(
        SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceConnectionClaim>(
          lifecycle,
          (state) => {
            switch (state._tag) {
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
                  },
                ];
            }
          },
        ),
      );
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
          yield* instrumentDiagnosticPhase(
            workspaceId,
            attempt,
            "preflight",
            probeWorkspace(
              buildCoderWorkspaceProbeInvocation(deployment, workspace, invocationOptions),
            ),
          );
          yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
          if (options?.helperBundlePath !== undefined) {
            yield* instrumentDiagnosticPhase(
              workspaceId,
              attempt,
              "installing_helper",
              installHelper({
                deployment,
                workspace,
                helperBundlePath: options.helperBundlePath,
                invocationOptions,
              }),
            );
            yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
          }
          const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
          return yield* Effect.gen(function* () {
            const connection = yield* instrumentDiagnosticPhase(
              workspaceId,
              attempt,
              "negotiating_helper",
              openHelper(buildCoderHelperInvocation(deployment, workspace, invocationOptions)).pipe(
                Scope.provide(connectionScope),
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
            runFork(
              connection.closed.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const state = SynchronizedRef.getUnsafe(lifecycle);
                    if (state._tag === "Connected" && state.connection === connection) {
                      recordDiagnosticEvent(workspaceId, attempt, "disconnected");
                    }
                  }),
                ),
                Effect.tap(() =>
                  SynchronizedRef.update(lifecycle, (state) =>
                    state._tag === "Connected" && state.connection === connection
                      ? ({ _tag: "Disconnected", generation: state.generation } as const)
                      : state,
                  ),
                ),
                Effect.ensuring(Scope.close(connectionScope, Exit.void)),
              ),
            );
            return { connection, rpcBridge } satisfies WorkspaceConnection;
          }).pipe(Effect.onError(() => Scope.close(connectionScope, Exit.void)));
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
      const claim = await runPromise(
        SynchronizedRef.modify<WorkspaceLifecycleState, WorkspaceCloseClaim>(lifecycle, (state) => {
          if (state._tag === "Changing") {
            return [{ _tag: "Changing" as const, operation: state.operation }, state];
          }
          const generation = state.generation + 1;
          if (state._tag === "Disconnected") {
            return [{ _tag: "Closed" as const }, { _tag: "Disconnected", generation }];
          }
          return [
            {
              _tag: "Close" as const,
              pending: state._tag === "Connecting" ? state.operation : undefined,
              scope: state._tag === "Connected" ? state.scope : undefined,
            },
            { _tag: "Disconnected", generation },
          ];
        }),
      );
      if (claim._tag === "Closed") return;
      if (claim._tag === "Changing") {
        await claim.operation.catch(() => undefined);
        return closeWorkspaceConnection(workspaceId);
      }
      workspacePings.delete(workspaceId);
      workspacePingStarts.delete(workspaceId);
      if (claim.scope !== undefined) {
        await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
      }
      if (claim.pending !== undefined) await claim.pending.catch(() => undefined);
      recordDiagnosticEvent(
        workspaceId,
        workspaceAttemptCounters.get(workspaceId) ?? 1,
        "disconnected",
      );
    };

    const ensureWorkspacePing = (workspaceId: string): Promise<CoderWorkspacePingConnection> => {
      const state = SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId));
      if (state._tag !== "Connected") {
        return Promise.reject(new Error("Coder workspace is not connected."));
      }
      const existing = workspacePings.get(workspaceId);
      if (existing?.helper === state.connection) return Promise.resolve(existing.connection);
      const pending = workspacePingStarts.get(workspaceId);
      if (pending !== undefined) return pending;

      const start = runPromise(
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
          const pingScope = yield* Scope.fork(state.scope, "sequential");
          return yield* Effect.gen(function* () {
            const connection = yield* openWorkspacePing(
              buildCoderPingWorkspaceInvocation(
                deployment,
                workspace,
                coderInvocationOptions(deployment.id),
              ),
            ).pipe(Scope.provide(pingScope));
            const currentState = SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId));
            if (
              currentState._tag !== "Connected" ||
              currentState.connection !== state.connection ||
              !workspaceConnectionIsCurrent(connectionConfig, profileConfig, workspaceId)
            ) {
              return yield* Effect.fail(new Error("Coder workspace connection changed."));
            }
            workspacePings.set(workspaceId, {
              connection,
              helper: state.connection,
            });
            runFork(
              connection.closed.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (workspacePings.get(workspaceId)?.connection === connection) {
                      workspacePings.delete(workspaceId);
                    }
                  }),
                ),
                Effect.ensuring(Scope.close(pingScope, Exit.void)),
              ),
            );
            return connection;
          }).pipe(Effect.onError(() => Scope.close(pingScope, Exit.void)));
        }),
      );
      workspacePingStarts.set(workspaceId, start);
      const cleanup = () => {
        if (workspacePingStarts.get(workspaceId) === start) {
          workspacePingStarts.delete(workspaceId);
        }
      };
      void start.then(cleanup, cleanup);
      return start;
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
          return yield* Effect.gen(function* () {
            const connection = yield* openPortForward(
              buildCoderPortForwardInvocation(
                deployment,
                workspace,
                portForward,
                coderInvocationOptions(deployment.id),
              ),
            ).pipe(Scope.provide(connectionScope));
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
            runFork(
              connection.closed.pipe(
                Effect.tap((exit) =>
                  SynchronizedRef.update(lifecycle, (state) => {
                    if (state._tag !== "Running" || state.connection !== connection) return state;
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
            return connection;
          }).pipe(Effect.onError(() => Scope.close(connectionScope, Exit.void)));
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
                scope: state._tag === "Running" ? state.scope : undefined,
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
          if (claim.scope !== undefined) {
            await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
          }
          if (claim.pending !== undefined) await claim.pending.catch(() => undefined);
          await runPromise(
            SynchronizedRef.update(lifecycle, (state) =>
              state._tag === "Stopping" && state.operation === deferred.promise
                ? ({ _tag: "Idle", generation: state.generation } as const)
                : state,
            ),
          );
          deferred.resolve(undefined);
        } catch (cause) {
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
                scope: state._tag === "Connected" ? state.scope : undefined,
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
            workspacePings.delete(workspaceId);
            workspacePingStarts.delete(workspaceId);
            if (claim.scope !== undefined) {
              await runPromise(Effect.uninterruptible(Scope.close(claim.scope, Exit.void)));
            }
            if (claim.pending !== undefined) await claim.pending.catch(() => undefined);
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
                    ? ({ _tag: "Disconnected", generation: state.generation } as const)
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
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({ events: [...diagnosticEventsFor(workspaceId)] }),
          );
          return;
        }
        const latencyRoute = request.url?.match(/^\/api\/workspaces\/([^/]+)\/latency$/);
        if (request.method === "GET" && latencyRoute !== null && latencyRoute !== undefined) {
          let workspaceId: string;
          try {
            workspaceId = decodeURIComponent(latencyRoute[1] ?? "");
          } catch {
            sendText(response, 400, "text/plain; charset=utf-8", "Invalid workspace id.");
            return;
          }
          if (!profileConfig.workspaces.some((entry) => entry.id === workspaceId)) {
            sendText(response, 404, "text/plain; charset=utf-8", "Unknown Coder workspace.");
            return;
          }
          try {
            const ping = await ensureWorkspacePing(workspaceId);
            sendText(
              response,
              200,
              "application/json; charset=utf-8",
              JSON.stringify({ sample: ping.latestSample() }),
            );
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Coder workspace ping failed.";
            sendText(
              response,
              message === "Coder workspace is not connected." ? 409 : 502,
              "text/plain; charset=utf-8",
              message,
            );
          }
          return;
        }
        const resourceUsageRoute = request.url?.match(/^\/api\/workspaces\/([^/]+)\/metrics$/);
        if (
          request.method === "GET" &&
          resourceUsageRoute !== null &&
          resourceUsageRoute !== undefined
        ) {
          let workspaceId: string;
          try {
            workspaceId = decodeURIComponent(resourceUsageRoute[1] ?? "");
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
          const state = SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId));
          if (state._tag !== "Connected") {
            sendText(
              response,
              409,
              "text/plain; charset=utf-8",
              "Coder workspace is not connected.",
            );
            return;
          }
          try {
            const invocationOptions = coderInvocationOptions(deployment.id);
            const [usage, healthy] = await Promise.all([
              runPromise(
                readWorkspaceResourceUsage(
                  buildCoderWorkspaceStatsInvocation(deployment, workspace, invocationOptions),
                ),
              ),
              runPromise(
                listWorkspaces(buildCoderListWorkspacesInvocation(deployment, invocationOptions)),
              )
                .then(
                  (workspaces) =>
                    workspaces.find((entry) => discoveredWorkspaceMatches(entry, workspace))
                      ?.healthy ?? null,
                )
                .catch(() => null),
            ]);
            const currentState = SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId));
            if (currentState._tag !== "Connected" || currentState.connection !== state.connection) {
              sendText(
                response,
                409,
                "text/plain; charset=utf-8",
                "Coder workspace connection changed.",
              );
              return;
            }
            sendText(
              response,
              200,
              "application/json; charset=utf-8",
              JSON.stringify({ healthy, ...usage }),
            );
          } catch (cause) {
            sendText(
              response,
              502,
              "text/plain; charset=utf-8",
              cause instanceof Error ? cause.message : "Coder workspace resource usage failed.",
            );
          }
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
                        : state._tag === "Failed"
                          ? "error"
                          : "starting",
                  ...(state._tag === "Failed" ? { error: state.error } : {}),
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
          try {
            const nextConfig = parseCoderProfileConfig(await readJsonBody(request));
            const savedConfig = await serializeConfigMutation(async () => {
              if (options?.configPath) await saveCoderProfileConfig(options.configPath, nextConfig);
              const previousConfig = profileConfig;
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
              profileConfig = nextConfig;
              await Promise.allSettled(
                [...stalePortForwardIds].map((portForwardId) => stopPortForward(portForwardId)),
              );
              for (const portForwardId of stalePortForwardIds) {
                portForwardLifecycles.delete(portForwardId);
              }
              await startConfiguredPortForwards();
              return profileConfig;
            });
            sendText(response, 200, "application/json; charset=utf-8", JSON.stringify(savedConfig));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Invalid configuration.";
            sendText(response, 400, "text/plain; charset=utf-8", message);
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
          if (SynchronizedRef.getUnsafe(workspaceLifecycle(workspaceId))._tag !== "Connected") {
            sendText(
              response,
              409,
              "text/plain; charset=utf-8",
              "Coder workspace is not connected.",
            );
            return;
          }
          const contentType = request.headers["content-type"] ?? "";
          try {
            const bytes = await readBody(request, MAX_CLIPBOARD_IMAGE_BYTES);
            const extension = validateClipboardImage(contentType, bytes);
            const path = await withStagedClipboardImage(bytes, extension, (localPath) =>
              runPromise(
                uploadClipboardImage({
                  deployment,
                  workspace,
                  localPath,
                  extension,
                  invocationOptions: coderInvocationOptions(deployment.id),
                }),
              ),
            );
            sendText(response, 200, "application/json; charset=utf-8", JSON.stringify({ path }));
          } catch (cause) {
            if (cause instanceof RequestBodyTooLargeError) {
              sendText(
                response,
                413,
                "text/plain; charset=utf-8",
                "Clipboard image exceeds 20 MiB.",
              );
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
        workspacePings.clear();
        workspacePingStarts.clear();
        workspaceDiagnosticEvents.clear();
        workspaceAttemptCounters.clear();
        pendingWorkspaceUpgrades.clear();
        yield* FiberSet.clear(fibers);
        const connectionScopes = [
          ...[...workspaceLifecycles.values()].flatMap((lifecycle) => {
            const state = SynchronizedRef.getUnsafe(lifecycle);
            return state._tag === "Connected" ? [state.scope] : [];
          }),
          ...[...portForwardLifecycles.values()].flatMap((lifecycle) => {
            const state = SynchronizedRef.getUnsafe(lifecycle);
            return state._tag === "Running" ? [state.scope] : [];
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

    yield* Effect.callback<void, Error>((resume) => {
      const onError = (cause: Error) => resume(Effect.fail(cause));
      server.once("error", onError);
      server.listen(0, CODER_GATEWAY_HOST, () => {
        server.off("error", onError);
        resume(Effect.void);
      });
      return Effect.sync(() => server.off("error", onError));
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.fail(new Error("Local gateway did not bind to a TCP port."));
    }

    yield* Effect.promise(startConfiguredPortForwards);

    return { url: `http://${CODER_GATEWAY_HOST}:${address.port}` };
  });
}

export interface PromiseCoderHelperConnection {
  readonly info: CoderHelperConnection["info"];
  readonly closed: Promise<CoderHelperExit>;
  readonly sendRpc: (message: unknown) => void;
  readonly onRpcMessage: CoderHelperConnection["onRpcMessage"];
  readonly close: () => void;
}

export interface PromiseCoderPortForwardConnection {
  readonly closed: Promise<CoderPortForwardExit>;
  readonly close: () => void;
}

interface LocalCoderGatewayOptions {
  readonly configPath?: string;
  readonly connectHelper?: (invocation: CoderInvocation) => Promise<PromiseCoderHelperConnection>;
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
  readonly startWorkspace?: (invocation: CoderInvocation) => Promise<void>;
  readonly stopWorkspace?: (invocation: CoderInvocation) => Promise<void>;
  readonly restartWorkspace?: (invocation: CoderInvocation) => Promise<void>;
  readonly updateWorkspace?: (invocation: CoderInvocation) => Promise<void>;
  readonly installHelper?: (
    input: Parameters<typeof installCoderHelperWithScp>[0],
  ) => Promise<void>;
  readonly uploadClipboardImage?: (
    input: Parameters<typeof uploadCoderClipboardImageWithScp>[0],
  ) => Promise<string>;
  readonly connectPortForward?: (
    invocation: CoderInvocation,
  ) => Promise<PromiseCoderPortForwardConnection>;
  readonly readWorkspaceResourceUsage?: (
    invocation: CoderInvocation,
  ) => Promise<CoderWorkspaceResourceUsage>;
  readonly workspaceResourceUsageTimeoutMs?: number;
}

const fromPromise = <A>(evaluate: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause });

/** Promise adapter for tests and embedders that cannot own an Effect scope. */
export async function startLocalCoderGateway(
  options?: LocalCoderGatewayOptions,
): Promise<LocalCoderGateway> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const effectOptions: LocalCoderGatewayEffectOptions = {
    ...(options?.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options?.helperBundlePath === undefined
      ? {}
      : { helperBundlePath: options.helperBundlePath }),
    ...(options?.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    ...(options?.workspaceProbeTimeoutMs === undefined
      ? {}
      : { workspaceProbeTimeoutMs: options.workspaceProbeTimeoutMs }),
    ...(options?.coderAuthStatusTimeoutMs === undefined
      ? {}
      : { coderAuthStatusTimeoutMs: options.coderAuthStatusTimeoutMs }),
    ...(options?.workspaceResourceUsageTimeoutMs === undefined
      ? {}
      : { workspaceResourceUsageTimeoutMs: options.workspaceResourceUsageTimeoutMs }),
    ...(options?.listWorkspaces === undefined
      ? {}
      : { listWorkspaces: (invocation) => fromPromise(() => options.listWorkspaces!(invocation)) }),
    ...(options?.probeWorkspace === undefined
      ? {}
      : { probeWorkspace: (invocation) => fromPromise(() => options.probeWorkspace!(invocation)) }),
    ...(options?.checkAuthentication === undefined
      ? {}
      : {
          checkAuthentication: (invocation) =>
            fromPromise(() => options.checkAuthentication!(invocation)),
        }),
    ...(options?.startWorkspace === undefined
      ? {}
      : { startWorkspace: (invocation) => fromPromise(() => options.startWorkspace!(invocation)) }),
    ...(options?.stopWorkspace === undefined
      ? {}
      : { stopWorkspace: (invocation) => fromPromise(() => options.stopWorkspace!(invocation)) }),
    ...(options?.restartWorkspace === undefined
      ? {}
      : {
          restartWorkspace: (invocation) =>
            fromPromise(() => options.restartWorkspace!(invocation)),
        }),
    ...(options?.updateWorkspace === undefined
      ? {}
      : {
          updateWorkspace: (invocation) => fromPromise(() => options.updateWorkspace!(invocation)),
        }),
    ...(options?.installHelper === undefined
      ? {}
      : { installHelper: (input) => fromPromise(() => options.installHelper!(input)) }),
    ...(options?.uploadClipboardImage === undefined
      ? {}
      : {
          uploadClipboardImage: (input) => fromPromise(() => options.uploadClipboardImage!(input)),
        }),
    ...(options?.connectPortForward === undefined
      ? {}
      : {
          connectPortForward: (invocation) =>
            Effect.acquireRelease(
              Effect.callback<CoderPortForwardConnection, unknown>((resume) => {
                let interrupted = false;
                let connecting: Promise<PromiseCoderPortForwardConnection>;
                try {
                  connecting = options.connectPortForward!(invocation);
                } catch (cause) {
                  resume(Effect.fail(cause));
                  return;
                }
                void connecting.then(
                  (connection) => {
                    if (interrupted) {
                      try {
                        connection.close();
                      } catch {
                        // A late legacy connection is already detached from the gateway.
                      }
                      void connection.closed.catch(() => undefined);
                      return;
                    }
                    let closed = false;
                    void connection.closed.then(
                      () => {
                        closed = true;
                      },
                      () => {
                        closed = true;
                      },
                    );
                    resume(
                      Effect.succeed({
                        closed: fromPromise(() => connection.closed).pipe(Effect.orDie),
                        close: Effect.suspend(() =>
                          closed ? Effect.void : Effect.sync(() => connection.close()),
                        ),
                      }),
                    );
                  },
                  (cause) => {
                    if (!interrupted) resume(Effect.fail(cause));
                  },
                );
                return Effect.sync(() => {
                  interrupted = true;
                });
              }),
              (connection) =>
                connection.close.pipe(
                  Effect.andThen(connection.closed),
                  Effect.timeoutOrElse({
                    duration: PROMISE_ADAPTER_CLOSE_TIMEOUT_MS,
                    orElse: () => Effect.void,
                  }),
                  Effect.asVoid,
                  Effect.catchCause(() => Effect.void),
                ),
              { interruptible: true },
            ),
        }),
    ...(options?.readWorkspaceResourceUsage === undefined
      ? {}
      : {
          readWorkspaceResourceUsage: (invocation) =>
            fromPromise(() => options.readWorkspaceResourceUsage!(invocation)),
        }),
    ...(options?.connectHelper === undefined
      ? {}
      : {
          connectHelper: (invocation) =>
            Effect.acquireRelease(
              Effect.callback<CoderHelperConnection, unknown>((resume) => {
                let interrupted = false;
                let connecting: Promise<PromiseCoderHelperConnection>;
                try {
                  connecting = options.connectHelper!(invocation);
                } catch (cause) {
                  resume(Effect.fail(cause));
                  return;
                }
                void connecting.then(
                  (connection) => {
                    if (interrupted) {
                      try {
                        connection.close();
                      } catch {
                        // A late legacy connection is already detached from the gateway.
                      }
                      void connection.closed.catch(() => undefined);
                      return;
                    }
                    resume(
                      Effect.succeed({
                        info: connection.info,
                        closed: fromPromise(() => connection.closed).pipe(Effect.orDie),
                        sendRpc: (message) =>
                          Effect.try({
                            try: () => connection.sendRpc(message),
                            catch: (cause) =>
                              new CoderHelperConnectionError(
                                "Coder workspace helper RPC request failed.",
                                { cause },
                              ),
                          }),
                        onRpcMessage: (listener) => connection.onRpcMessage(listener),
                        close: Effect.sync(() => connection.close()),
                      }),
                    );
                  },
                  (cause) => {
                    if (!interrupted) resume(Effect.fail(cause));
                  },
                );
                return Effect.sync(() => {
                  interrupted = true;
                });
              }),
              (connection) =>
                connection.close.pipe(
                  Effect.andThen(connection.closed),
                  Effect.timeoutOrElse({
                    duration: PROMISE_ADAPTER_CLOSE_TIMEOUT_MS,
                    orElse: () => Effect.void,
                  }),
                  Effect.asVoid,
                  Effect.catchCause(() => Effect.void),
                ),
              { interruptible: true },
            ),
        }),
  };

  try {
    const gateway = await Effect.runPromise(
      makeLocalCoderGateway(effectOptions).pipe(Scope.provide(scope)),
    );
    let closePromise: Promise<void> | undefined;
    return {
      ...gateway,
      close: () => (closePromise ??= Effect.runPromise(Scope.close(scope, Exit.void))),
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  }
}
