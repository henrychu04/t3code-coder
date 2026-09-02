import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { ConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const TARGET = new ConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isRpcRequest = Schema.is(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const factory = yield* RpcSession.RpcSessionFactory.pipe(
    Effect.provide(RpcSession.layer.pipe(Layer.provide(constructorLayer))),
  );
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) return socket;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent.map((message) => decodeJson(message)).filter(isRpcRequest)[index];
    if (request) return request;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.subscribeServerConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Chunk",
      requestId: request.id,
      values: [{ version: 1, type: "snapshot", config: ENCODED_SERVER_CONFIG }],
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("uses one config subscription for initial sync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const readyFiber = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(readyFiber);

        expect(yield* session.initialConfig).toEqual(SERVER_CONFIG);
        expect(
          socket.sent
            .map((message) => decodeJson(message))
            .filter(isRpcRequest)
            .map((request) => request.tag),
        ).toEqual([WS_METHODS.subscribeServerConfig]);
      }),
    ),
  );

  it.effect("replays current config and broadcasts updates to every subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const readyFiber = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(readyFiber);

        const collectTwo = session
          .subscribeServerConfig({})
          .pipe(Stream.take(2), Stream.runCollect);
        const firstSubscriber = yield* Effect.forkChild(collectTwo);
        const secondSubscriber = yield* Effect.forkChild(collectTwo);
        yield* Effect.yieldNow;

        const shortcut = {
          key: "k",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        };
        const request = yield* awaitRequest(socket);
        socket.serverMessage(
          encodeJson({
            _tag: "Chunk",
            requestId: request.id,
            values: [
              {
                version: 1,
                type: "keybindingsUpdated",
                payload: {
                  keybindings: [{ command: "terminal.toggle", shortcut }],
                  issues: [],
                },
              },
            ],
          }),
        );

        const firstEvents = Array.from(yield* Fiber.join(firstSubscriber));
        const secondEvents = Array.from(yield* Fiber.join(secondSubscriber));
        expect(firstEvents.map((event) => event.type)).toEqual(["snapshot", "keybindingsUpdated"]);
        expect(secondEvents).toEqual(firstEvents);
        expect(socket.sent.map((message) => decodeJson(message)).filter(isRpcRequest)).toHaveLength(
          1,
        );

        const replay = yield* session.subscribeServerConfig({}).pipe(Stream.runHead);
        expect(replay).toMatchObject({
          _tag: "Some",
          value: {
            type: "snapshot",
            config: { keybindings: [{ command: "terminal.toggle", shortcut }] },
          },
        });
      }),
    ),
  );
});
