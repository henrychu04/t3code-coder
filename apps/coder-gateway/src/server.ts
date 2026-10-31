import type { DiscoveredCoderWorkspace } from "@t3tools/contracts";
export type {
  DiscoveredCoderWorkspace,
  WorkspaceDiagnosticPhase,
  WorkspaceDiagnosticEvent,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

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
  buildCoderAuthStatusInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  REMOTE_HELPER_READY_SENTINEL,
  type CoderInvocation,
} from "@t3tools/coder-cli/command";
import {
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
import {
  checkCoderAuthStatus,
  runCoderLogin,
  runCoderWorkspaceAction,
  runCoderWorkspaceList,
  type CoderAuthenticationStatus,
  type WorkspaceAction,
} from "./coderCommands.ts";
import {
  assertDeploymentUrlsUnchanged,
  CoderConfigConflictError,
  portForwardIsCurrent,
  workspaceConnectionIsCurrent,
} from "./configChanges.ts";
import {
  CODER_GATEWAY_HOST,
  indexHtml,
  isServerNotRunningError,
  readImmutableBuildAssets,
  readJsonBody,
  rejectWebSocketUpgrade,
  sendText,
  serveStaticFile,
} from "./http.ts";
import { WorkspaceActionConflictError, type WorkspaceConnection } from "./lifecycleState.ts";
import { makePortForwardManager } from "./portForwards.ts";
import { findFreeForwardPort, MAX_LOCAL_PORT_CANDIDATES } from "./portProbe.ts";
import { RpcBridgeSessionError, type RpcBridgeSession } from "./rpcBridge.ts";
import { makeCoderHub } from "./hub.ts";
import { readSavedGatewayPort, saveGatewayPort } from "./savedPort.ts";
import { makeWorkspaceConnectionManager } from "./workspaceConnections.ts";

export { runCoderAuthStatus, type CoderAuthenticationStatus } from "./coderCommands.ts";
export { CODER_GATEWAY_HOST } from "./http.ts";

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
    const workspaceSockets = new Map<string, WebSocket>();
    const pendingWorkspaceUpgrades = new Set<string>();
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
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: CODER_RPC_FRAME_MAX_BYTES,
      perMessageDeflate: false,
    });

    const portForwards = makePortForwardManager({
      runPromise,
      runFork,
      gatewayScope,
      config: () => profileConfig,
      isClosed: () => gatewayClosed,
      coderInvocationOptions,
      openPortForward,
      listWorkspaces,
    });
    const {
      portForwardLifecycles,
      portForwardLifecycle,
      ensurePortForward,
      stopPortForward,
      startConfiguredPortForwards,
    } = portForwards;
    const {
      workspaceLifecycles,
      workspaceLifecycle,
      diagnosticEventsFor,
      clearWorkspaceDiagnostics,
      ensureWorkspaceConnection,
      closeWorkspaceConnection,
      runWorkspaceAction,
    } = makeWorkspaceConnectionManager({
      runPromise,
      runFork,
      gatewayScope,
      config: () => profileConfig,
      isClosed: () => gatewayClosed,
      coderInvocationOptions,
      hub,
      workspaceSockets,
      portForwards,
      openHelper,
      helperBundlePath,
      helperBundleHash,
      installHelper,
      runWorkspaceStart,
      runWorkspaceStop,
      runWorkspaceRestart,
      runWorkspaceUpdate,
    });

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
              await startConfiguredPortForwards({ retryFailed: false });
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
        clearWorkspaceDiagnostics();
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

    yield* Effect.promise(() => startConfiguredPortForwards());

    return { url: `http://${CODER_GATEWAY_HOST}:${address.port}` };
  });
}
