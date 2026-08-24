// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
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
  buildCoderWorkspaceProbeInvocation,
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
  if (name.length === 0) return null;
  return { name, target: owner.length === 0 ? name : `${owner}/${name}` };
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
  readonly installHelper?: (
    input: Parameters<typeof installCoderHelperWithScp>[0],
  ) => Effect.Effect<void, unknown>;
  readonly uploadClipboardImage?: (
    input: Parameters<typeof uploadCoderClipboardImageWithScp>[0],
  ) => Effect.Effect<string, unknown>;
  readonly connectPortForward?: (
    invocation: CoderInvocation,
  ) => Effect.Effect<CoderPortForwardConnection, unknown, Scope.Scope>;
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
    const workspaceConnections = new Map<string, CoderHelperConnection>();
    const workspaceConnectionScopes = new Map<string, Scope.Closeable>();
    const workspaceConnectionStarts = new Map<string, Promise<CoderHelperConnection>>();
    const workspaceConnectionGenerations = new Map<string, number>();
    const workspaceSockets = new Map<string, WebSocket>();
    const pendingWorkspaceUpgrades = new Set<string>();
    const portForwardConnections = new Map<string, CoderPortForwardConnection>();
    const portForwardConnectionScopes = new Map<string, Scope.Closeable>();
    const portForwardStarts = new Map<string, Promise<CoderPortForwardConnection>>();
    const portForwardGenerations = new Map<string, number>();
    const portForwardErrors = new Map<string, string>();
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
    const installHelper = options?.installHelper ?? installCoderHelperWithScp;
    const uploadClipboardImage = options?.uploadClipboardImage ?? uploadCoderClipboardImageWithScp;
    const openPortForward = options?.connectPortForward ?? connectCoderPortForward;
    const coderInvocationOptions = (deploymentId: string) => ({
      globalConfig: NodePath.join(
        NodePath.dirname(options?.configPath ?? NodePath.join(process.cwd(), "config.json")),
        "coder-profiles",
        deploymentId,
      ),
    });
    const closeWorkspaceConnection = (workspaceId: string): Promise<void> => {
      workspaceConnections.delete(workspaceId);
      const scope = workspaceConnectionScopes.get(workspaceId);
      workspaceConnectionScopes.delete(workspaceId);
      return scope === undefined
        ? Promise.resolve()
        : runPromise(Effect.uninterruptible(Scope.close(scope, Exit.void)));
    };
    const closePortForwardConnection = (portForwardId: string): Promise<void> => {
      portForwardConnections.delete(portForwardId);
      const scope = portForwardConnectionScopes.get(portForwardId);
      portForwardConnectionScopes.delete(portForwardId);
      return scope === undefined
        ? Promise.resolve()
        : runPromise(Effect.uninterruptible(Scope.close(scope, Exit.void)));
    };
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_RPC_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    const ensureWorkspaceConnection = async (
      workspaceId: string,
    ): Promise<CoderHelperConnection> => {
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
          const invocationOptions = coderInvocationOptions(deployment.id);
          yield* probeWorkspace(
            buildCoderWorkspaceProbeInvocation(deployment, workspace, invocationOptions),
          );
          yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
          if (options?.helperBundlePath !== undefined) {
            yield* installHelper({
              deployment,
              workspace,
              helperBundlePath: options.helperBundlePath,
              invocationOptions,
            });
            yield* Effect.try({ try: assertStartIsCurrent, catch: (cause) => cause });
          }
          const connectionScope = yield* Scope.fork(gatewayScope, "sequential");
          return yield* Effect.gen(function* () {
            const connection = yield* openHelper(
              buildCoderHelperInvocation(deployment, workspace, invocationOptions),
            ).pipe(Scope.provide(connectionScope));
            if (!startIsCurrent()) {
              return yield* Effect.fail(new Error("Coder workspace connection was cancelled."));
            }
            if (!workspaceConnectionIsCurrent(connectionConfig, profileConfig, workspaceId)) {
              return yield* Effect.fail(
                new Error("Coder workspace configuration changed while connecting."),
              );
            }
            workspaceConnections.set(workspaceId, connection);
            workspaceConnectionScopes.set(workspaceId, connectionScope);
            runFork(
              connection.closed.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (workspaceConnections.get(workspaceId) === connection) {
                      workspaceConnections.delete(workspaceId);
                      workspaceConnectionScopes.delete(workspaceId);
                    }
                  }),
                ),
                Effect.ensuring(Scope.close(connectionScope, Exit.void)),
              ),
            );
            return connection;
          }).pipe(Effect.onError(() => Scope.close(connectionScope, Exit.void)));
        }),
      );
      workspaceConnectionStarts.set(workspaceId, start);
      try {
        return await start;
      } finally {
        if (workspaceConnectionStarts.get(workspaceId) === start) {
          workspaceConnectionStarts.delete(workspaceId);
        }
      }
    };

    const ensurePortForward = async (
      portForwardId: string,
    ): Promise<CoderPortForwardConnection> => {
      if (gatewayClosed) throw new Error("Coder gateway is closed.");
      const existing = portForwardConnections.get(portForwardId);
      if (existing !== undefined) return existing;
      const pending = portForwardStarts.get(portForwardId);
      if (pending !== undefined) return pending;

      const generation = portForwardGenerations.get(portForwardId) ?? 0;
      const startIsCurrent = () =>
        !gatewayClosed && (portForwardGenerations.get(portForwardId) ?? 0) === generation;
      const start = runPromise(
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
          portForwardConnectionScopes.set(portForwardId, connectionScope);
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

            portForwardConnections.set(portForwardId, connection);
            portForwardErrors.delete(portForwardId);
            runFork(
              connection.closed.pipe(
                Effect.tap((exit) =>
                  Effect.sync(() => {
                    if (portForwardConnections.get(portForwardId) === connection) {
                      portForwardConnections.delete(portForwardId);
                      portForwardConnectionScopes.delete(portForwardId);
                    }
                    if (
                      !exit.expected &&
                      !gatewayClosed &&
                      portForwardIsCurrent(connectionConfig, profileConfig, portForwardId)
                    ) {
                      portForwardErrors.set(
                        portForwardId,
                        exit.reason ?? "Coder port forward stopped unexpectedly.",
                      );
                    }
                  }),
                ),
                Effect.ensuring(Scope.close(connectionScope, Exit.void)),
              ),
            );
            return connection;
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                if (portForwardConnectionScopes.get(portForwardId) === connectionScope) {
                  portForwardConnectionScopes.delete(portForwardId);
                }
                yield* Scope.close(connectionScope, Exit.void);
              }),
            ),
          );
        }),
      );
      portForwardStarts.set(portForwardId, start);
      try {
        return await start;
      } catch (cause) {
        if (
          startIsCurrent() &&
          profileConfig.portForwards?.some((entry) => entry.id === portForwardId)
        ) {
          portForwardErrors.set(
            portForwardId,
            cause instanceof Error ? cause.message : "Coder port forward failed to start.",
          );
        }
        throw cause;
      } finally {
        if (portForwardStarts.get(portForwardId) === start) {
          portForwardStarts.delete(portForwardId);
        }
      }
    };

    const stopPortForward = async (portForwardId: string): Promise<void> => {
      portForwardGenerations.set(
        portForwardId,
        (portForwardGenerations.get(portForwardId) ?? 0) + 1,
      );
      const pending = portForwardStarts.get(portForwardId);
      await closePortForwardConnection(portForwardId);
      if (pending !== undefined) await pending.catch(() => undefined);
    };

    const startConfiguredPortForwards = async (): Promise<void> => {
      await Promise.allSettled(
        (profileConfig.portForwards ?? []).map((portForward) => ensurePortForward(portForward.id)),
      );
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
        if (request.method === "GET" && request.url === "/api/port-forwards") {
          sendText(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({
              portForwards: (profileConfig.portForwards ?? []).map((portForward) => {
                const error = portForwardErrors.get(portForward.id);
                return {
                  id: portForward.id,
                  status: portForwardStarts.has(portForward.id)
                    ? "starting"
                    : portForwardConnections.has(portForward.id)
                      ? "running"
                      : error === undefined
                        ? "starting"
                        : "error",
                  ...(error === undefined ? {} : { error }),
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
              for (const workspaceId of workspaceConnections.keys()) {
                if (workspaceConnectionIsCurrent(previousConfig, nextConfig, workspaceId)) continue;
                await closeWorkspaceConnection(workspaceId);
                workspaceSockets.get(workspaceId)?.close(1001, "Workspace configuration changed.");
              }
              profileConfig = nextConfig;
              await Promise.allSettled(
                [...stalePortForwardIds].map((portForwardId) => stopPortForward(portForwardId)),
              );
              for (const portForwardId of stalePortForwardIds) {
                portForwardErrors.delete(portForwardId);
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
            portForwardErrors.delete(portForwardId);
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
            await closeWorkspaceConnection(workspaceId);
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
              void runPromise(helper.sendRpc(message)).catch(() => {
                webSocket.close(1011, "Coder workspace disconnected.");
              });
            });
            webSocket.once("close", () => {
              unsubscribe();
              if (workspaceSockets.get(workspaceId) === webSocket) {
                workspaceSockets.delete(workspaceId);
              }
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
        pendingWorkspaceUpgrades.clear();
        yield* FiberSet.clear(fibers);
        const connectionScopes = [
          ...workspaceConnectionScopes.values(),
          ...portForwardConnectionScopes.values(),
        ];
        workspaceConnections.clear();
        workspaceConnectionScopes.clear();
        portForwardConnections.clear();
        portForwardConnectionScopes.clear();
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
  readonly installHelper?: (
    input: Parameters<typeof installCoderHelperWithScp>[0],
  ) => Promise<void>;
  readonly uploadClipboardImage?: (
    input: Parameters<typeof uploadCoderClipboardImageWithScp>[0],
  ) => Promise<string>;
  readonly connectPortForward?: (
    invocation: CoderInvocation,
  ) => Promise<PromiseCoderPortForwardConnection>;
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
