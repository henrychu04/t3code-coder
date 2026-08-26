import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

type RpcRequestId = string | number;
type BrowserRpcMessage = RpcMessage.FromClientEncoded;
type HelperRpcMessage = RpcMessage.FromServerEncoded;

const DEFAULT_CLEANUP_TIMEOUT = "5 seconds";

export interface RpcBridgeTransport {
  readonly isOpen: () => boolean;
  readonly send: (encoded: string) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface RpcBridgeSession {
  readonly receive: (message: unknown) => Effect.Effect<void, RpcBridgeSessionError>;
  readonly close: Effect.Effect<void>;
}

export interface WorkspaceRpcBridge {
  readonly attach: (
    transport: RpcBridgeTransport,
  ) => Effect.Effect<RpcBridgeSession, RpcBridgeConflictError>;
}

export interface WorkspaceRpcBridgeOptions {
  readonly cleanupTimeout?: Duration.Input;
}

export class RpcBridgeConflictError extends Error {
  readonly _tag = "RpcBridgeConflictError";

  constructor() {
    super("A browser RPC session is already attached to this workspace helper.");
    this.name = "RpcBridgeConflictError";
  }
}

export class RpcBridgeSessionError extends Error {
  readonly _tag = "RpcBridgeSessionError";
  readonly kind: "protocol" | "helper";

  constructor(message: string, kind: "protocol" | "helper" = "protocol", options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcBridgeSessionError";
    this.kind = kind;
  }
}

interface ActiveSession {
  readonly id: number;
  readonly transport: RpcBridgeTransport;
  readonly browserRequests: ReadonlyMap<string, string>;
}

interface RequestRoute {
  readonly sessionId: number;
  readonly browserRequestId: RpcRequestId;
  readonly browserRequestKey: string;
}

interface BridgeState {
  readonly nextSessionId: number;
  readonly nextHelperRequestId: number;
  readonly activeSession: ActiveSession | null;
  readonly helperRequests: ReadonlyMap<string, RequestRoute>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RpcRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function requestKey(requestId: RpcRequestId): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function decodeBrowserMessage(message: unknown): BrowserRpcMessage {
  if (!isRecord(message) || typeof message._tag !== "string") {
    throw new RpcBridgeSessionError("Browser sent an invalid RPC envelope.");
  }
  switch (message._tag) {
    case "Request":
      if (!isRequestId(message.id) || typeof message.tag !== "string") {
        throw new RpcBridgeSessionError("Browser sent an invalid RPC request.");
      }
      return message as unknown as BrowserRpcMessage;
    case "Ack":
    case "Interrupt":
      if (!isRequestId(message.requestId)) {
        throw new RpcBridgeSessionError("Browser sent an invalid RPC request reference.");
      }
      return message as unknown as BrowserRpcMessage;
    case "Ping":
    case "Eof":
      return message as unknown as BrowserRpcMessage;
    default:
      throw new RpcBridgeSessionError(`Browser sent an unsupported RPC envelope ${message._tag}.`);
  }
}

function decodeHelperMessage(message: unknown): HelperRpcMessage {
  if (!isRecord(message) || typeof message._tag !== "string") {
    throw new RpcBridgeSessionError("Workspace helper sent an invalid RPC envelope.", "helper");
  }
  switch (message._tag) {
    case "Chunk":
    case "Exit":
      if (!isRequestId(message.requestId)) {
        throw new RpcBridgeSessionError(
          "Workspace helper sent an invalid RPC response reference.",
          "helper",
        );
      }
      return message as unknown as HelperRpcMessage;
    case "Pong":
    case "ClientProtocolError":
    case "Defect":
      return message as unknown as HelperRpcMessage;
    default:
      throw new RpcBridgeSessionError(
        `Workspace helper sent an unsupported RPC envelope ${message._tag}.`,
        "helper",
      );
  }
}

function encodeMessage(message: BrowserRpcMessage | HelperRpcMessage): string {
  try {
    return JSON.stringify(message);
  } catch (cause) {
    throw new RpcBridgeSessionError("RPC envelope could not be encoded.", "protocol", { cause });
  }
}

function transportSend(transport: RpcBridgeTransport, encoded: string): void {
  if (!transport.isOpen()) return;
  try {
    transport.send(encoded);
  } catch {
    transport.close(1011, "RPC browser connection failed.");
  }
}

export function makeWorkspaceRpcBridge(
  helper: CoderHelperConnection,
  options?: WorkspaceRpcBridgeOptions,
): Effect.Effect<WorkspaceRpcBridge, never, Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<BridgeState>({
      nextSessionId: 0,
      nextHelperRequestId: 0,
      activeSession: null,
      helperRequests: new Map(),
    });
    const fibers = yield* FiberSet.make();
    const runFork = yield* FiberSet.runtime(fibers)();
    const cleanupTimeout = options?.cleanupTimeout ?? DEFAULT_CLEANUP_TIMEOUT;

    const closeHelper = helper.close.pipe(Effect.catchCause(() => Effect.void));

    const scheduleCleanupCheck = (sessionId: number): void => {
      runFork(
        Effect.gen(function* () {
          yield* Effect.sleep(cleanupTimeout);
          const current = yield* SynchronizedRef.get(state);
          if (
            Array.from(current.helperRequests.values()).some(
              (route) => route.sessionId === sessionId,
            )
          ) {
            yield* closeHelper;
          }
        }),
      );
    };

    const detach = (sessionId: number): Effect.Effect<void> =>
      SynchronizedRef.modifyEffect(state, (current) => {
        if (current.activeSession?.id !== sessionId) {
          return Effect.succeed([{ exit: Exit.void, requestCount: 0 }, current] as const);
        }
        const requests = Array.from(current.helperRequests.entries()).filter(
          ([, route]) => route.sessionId === sessionId,
        );
        const next: BridgeState = { ...current, activeSession: null };
        return Effect.exit(
          Effect.forEach(
            requests,
            ([helperRequestId]) => {
              const interrupt: RpcMessage.InterruptEncoded = {
                _tag: "Interrupt",
                requestId: helperRequestId,
              };
              return helper.sendRpc(interrupt);
            },
            { discard: true },
          ),
        ).pipe(Effect.map((exit) => [{ exit, requestCount: requests.length }, next] as const));
      }).pipe(
        Effect.flatMap(({ exit, requestCount }) => {
          if (requestCount > 0) scheduleCleanupCheck(sessionId);
          return Exit.isFailure(exit) ? closeHelper : Effect.void;
        }),
      );

    const receiveBrowser = (
      sessionId: number,
      message: unknown,
    ): Effect.Effect<void, RpcBridgeSessionError> =>
      Effect.try({
        try: () => decodeBrowserMessage(message),
        catch: (cause) =>
          cause instanceof RpcBridgeSessionError
            ? cause
            : new RpcBridgeSessionError("Browser sent an invalid RPC envelope.", "protocol", {
                cause,
              }),
      }).pipe(
        Effect.flatMap((decoded) => {
          if (decoded._tag === "Eof") return detach(sessionId);
          return SynchronizedRef.modifyEffect(state, (current) => {
            const active = current.activeSession;
            if (active?.id !== sessionId) {
              return Effect.fail(
                new RpcBridgeSessionError("Browser RPC session is no longer attached."),
              );
            }
            if (decoded._tag === "Ping") {
              return helper.sendRpc(decoded).pipe(
                Effect.mapError(
                  (cause) =>
                    new RpcBridgeSessionError("Workspace helper is disconnected.", "helper", {
                      cause,
                    }),
                ),
                Effect.as([undefined, current] as const),
              );
            }
            if (decoded._tag === "Request") {
              const browserRequestKey = requestKey(decoded.id);
              if (active.browserRequests.has(browserRequestKey)) {
                return Effect.fail(
                  new RpcBridgeSessionError("Browser reused an active RPC request id."),
                );
              }
              const helperRequestId = `browser:${String(current.nextHelperRequestId)}`;
              const translated = { ...decoded, id: helperRequestId };
              const browserRequests = new Map(active.browserRequests);
              browserRequests.set(browserRequestKey, helperRequestId);
              const helperRequests = new Map(current.helperRequests);
              helperRequests.set(helperRequestId, {
                sessionId,
                browserRequestId: decoded.id,
                browserRequestKey,
              });
              const next: BridgeState = {
                ...current,
                nextHelperRequestId: current.nextHelperRequestId + 1,
                activeSession: { ...active, browserRequests },
                helperRequests,
              };
              return helper.sendRpc(translated).pipe(
                Effect.mapError(
                  (cause) =>
                    new RpcBridgeSessionError("Workspace helper is disconnected.", "helper", {
                      cause,
                    }),
                ),
                Effect.as([undefined, next] as const),
              );
            }

            const browserRequestKey = requestKey(decoded.requestId);
            const helperRequestId = active.browserRequests.get(browserRequestKey);
            if (helperRequestId === undefined) {
              return Effect.succeed([undefined, current] as const);
            }
            const route = current.helperRequests.get(helperRequestId);
            if (route === undefined) {
              return Effect.succeed([undefined, current] as const);
            }
            const translated = { ...decoded, requestId: helperRequestId };
            return helper.sendRpc(translated).pipe(
              Effect.mapError(
                (cause) =>
                  new RpcBridgeSessionError("Workspace helper is disconnected.", "helper", {
                    cause,
                  }),
              ),
              Effect.as([undefined, current] as const),
            );
          });
        }),
      );

    const receiveHelper = (message: unknown): Effect.Effect<void, RpcBridgeSessionError> =>
      Effect.try({
        try: () => decodeHelperMessage(message),
        catch: (cause) =>
          cause instanceof RpcBridgeSessionError
            ? cause
            : new RpcBridgeSessionError(
                "Workspace helper sent an invalid RPC envelope.",
                "helper",
                { cause },
              ),
      }).pipe(
        Effect.flatMap((decoded) =>
          SynchronizedRef.modifyEffect(state, (current) => {
            if (decoded._tag !== "Chunk" && decoded._tag !== "Exit") {
              const active = current.activeSession;
              if (active === null || !active.transport.isOpen()) {
                return Effect.succeed([undefined, current] as const);
              }
              const encoded = encodeMessage(decoded);
              return Effect.sync(() => transportSend(active.transport, encoded)).pipe(
                Effect.as([undefined, current] as const),
              );
            }

            const helperRequestId = String(decoded.requestId);
            const route = current.helperRequests.get(helperRequestId);
            if (route === undefined) {
              return Effect.succeed([undefined, current] as const);
            }
            let next = current;
            if (decoded._tag === "Exit") {
              const helperRequests = new Map(current.helperRequests);
              helperRequests.delete(helperRequestId);
              let activeSession = current.activeSession;
              if (activeSession?.id === route.sessionId) {
                const browserRequests = new Map(activeSession.browserRequests);
                browserRequests.delete(route.browserRequestKey);
                activeSession = { ...activeSession, browserRequests };
              }
              next = { ...current, activeSession, helperRequests };
            }
            const active = current.activeSession;
            if (active?.id !== route.sessionId || !active.transport.isOpen()) {
              return Effect.succeed([undefined, next] as const);
            }
            const translated = { ...decoded, requestId: route.browserRequestId };
            const encoded = encodeMessage(translated);
            return Effect.sync(() => transportSend(active.transport, encoded)).pipe(
              Effect.as([undefined, next] as const),
            );
          }),
        ),
      );

    const unsubscribe = yield* Effect.acquireRelease(
      Effect.sync(() =>
        helper.onRpcMessage((message) => {
          runFork(receiveHelper(message).pipe(Effect.catchCause(() => closeHelper)));
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    void unsubscribe;

    const attach: WorkspaceRpcBridge["attach"] = (transport) =>
      SynchronizedRef.modifyEffect(state, (current) => {
        if (current.activeSession !== null) {
          return Effect.fail(new RpcBridgeConflictError());
        }
        const sessionId = current.nextSessionId;
        const activeSession: ActiveSession = {
          id: sessionId,
          transport,
          browserRequests: new Map(),
        };
        const session: RpcBridgeSession = {
          receive: (message) => receiveBrowser(sessionId, message),
          close: detach(sessionId),
        };
        return Effect.succeed([
          session,
          {
            ...current,
            nextSessionId: sessionId + 1,
            activeSession,
          },
        ] as const);
      });

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) =>
          current.activeSession === null ? Effect.void : detach(current.activeSession.id),
        ),
      ),
    );

    return { attach } satisfies WorkspaceRpcBridge;
  });
}
