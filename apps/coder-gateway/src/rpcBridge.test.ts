import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  makeWorkspaceRpcBridge,
  RpcBridgeConflictError,
  RpcBridgeSessionError,
  type RpcBridgeTransport,
} from "./rpcBridge.ts";

interface FakeHelper {
  readonly connection: CoderHelperConnection;
  readonly sent: Array<unknown>;
  readonly emit: (message: unknown) => void;
  readonly closeCount: () => number;
}

function fakeHelper(): FakeHelper {
  const sent: Array<unknown> = [];
  const listeners = new Set<(message: unknown) => void>();
  let closes = 0;
  return {
    connection: {
      info: {} as never,
      closed: Effect.never,
      sendRpc: (message) => Effect.sync(() => void sent.push(message)),
      onRpcMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: Effect.sync(() => {
        closes += 1;
      }),
    },
    sent,
    emit: (message) => {
      for (const listener of listeners) listener(message);
    },
    closeCount: () => closes,
  };
}

interface FakeTransport extends RpcBridgeTransport {
  readonly messages: Array<unknown>;
  readonly closeEvents: Array<{ readonly code: number; readonly reason: string }>;
}

function fakeTransport(): FakeTransport {
  const messages: Array<unknown> = [];
  const closeEvents: Array<{ readonly code: number; readonly reason: string }> = [];
  let open = true;
  return {
    messages,
    closeEvents,
    isOpen: () => open,
    send: (encoded) => {
      messages.push(JSON.parse(encoded) as unknown);
    },
    close: (code, reason) => {
      open = false;
      closeEvents.push({ code, reason });
    },
  };
}

async function eventually(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
}

async function withBridge(
  run: (input: {
    readonly helper: FakeHelper;
    readonly bridge: Awaited<ReturnType<typeof makeBridge>>["bridge"];
  }) => Promise<void>,
  cleanupTimeout: number = 5_000,
): Promise<void> {
  const created = await makeBridge(cleanupTimeout);
  try {
    await run(created);
  } finally {
    await Effect.runPromise(Scope.close(created.scope, Exit.void));
  }
}

async function makeBridge(cleanupTimeout: number) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const helper = fakeHelper();
  const bridge = await Effect.runPromise(
    makeWorkspaceRpcBridge(helper.connection, { cleanupTimeout }).pipe(Scope.provide(scope)),
  );
  return { bridge, helper, scope };
}

test("translates browser request ids for the helper and restores them in responses", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const transport = fakeTransport();
    const session = await Effect.runPromise(bridge.attach(transport));
    await Effect.runPromise(
      session.receive({
        _tag: "Request",
        id: 7,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );

    const forwarded = helper.sent[0] as { readonly id: string };
    assert.match(forwarded.id, /^browser:\d+$/);
    assert.notEqual(forwarded.id, 7);

    helper.emit({ _tag: "Chunk", requestId: forwarded.id, values: [{ value: 1 }] });
    await eventually(() =>
      assert.deepEqual(transport.messages, [
        { _tag: "Chunk", requestId: 7, values: [{ value: 1 }] },
      ]),
    );

    helper.emit({
      _tag: "Exit",
      requestId: forwarded.id,
      exit: { _tag: "Success", value: undefined },
    });
    await eventually(() => assert.equal(transport.messages.length, 2));
    await Effect.runPromise(session.close);
    assert.equal(helper.sent.length, 1, "completed requests must not be interrupted on detach");
  });
});

test("reconnects with reused browser ids without colliding with detached requests", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const firstTransport = fakeTransport();
    const first = await Effect.runPromise(bridge.attach(firstTransport));
    await Effect.runPromise(
      first.receive({
        _tag: "Request",
        id: 7,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );
    const firstHelperId = (helper.sent[0] as { readonly id: string }).id;
    await Effect.runPromise(first.close);
    assert.deepEqual(helper.sent[1], { _tag: "Interrupt", requestId: firstHelperId });

    const secondTransport = fakeTransport();
    const second = await Effect.runPromise(bridge.attach(secondTransport));
    await Effect.runPromise(
      second.receive({
        _tag: "Request",
        id: 7,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );
    const secondHelperId = (helper.sent[2] as { readonly id: string }).id;
    assert.notEqual(secondHelperId, firstHelperId);

    helper.emit({ _tag: "Chunk", requestId: firstHelperId, values: ["stale"] });
    helper.emit({ _tag: "Chunk", requestId: secondHelperId, values: ["current"] });
    await eventually(() =>
      assert.deepEqual(secondTransport.messages, [
        { _tag: "Chunk", requestId: 7, values: ["current"] },
      ]),
    );
    assert.deepEqual(firstTransport.messages, []);

    helper.emit({
      _tag: "Exit",
      requestId: firstHelperId,
      exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] },
    });
    helper.emit({
      _tag: "Exit",
      requestId: secondHelperId,
      exit: { _tag: "Success", value: undefined },
    });
  });
});

test("keeps numeric and string browser request ids distinct and translates control messages", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const session = await Effect.runPromise(bridge.attach(fakeTransport()));
    for (const id of [7, "7"] as const) {
      await Effect.runPromise(
        session.receive({
          _tag: "Request",
          id,
          tag: "test.stream",
          payload: {},
          headers: [],
        }),
      );
    }
    const numericHelperId = (helper.sent[0] as { readonly id: string }).id;
    const stringHelperId = (helper.sent[1] as { readonly id: string }).id;
    assert.notEqual(numericHelperId, stringHelperId);

    await Effect.runPromise(session.receive({ _tag: "Ack", requestId: 7 }));
    await Effect.runPromise(session.receive({ _tag: "Interrupt", requestId: "7" }));
    assert.deepEqual(helper.sent[2], { _tag: "Ack", requestId: numericHelperId });
    assert.deepEqual(helper.sent[3], { _tag: "Interrupt", requestId: stringHelperId });

    await assert.rejects(
      Effect.runPromise(
        session.receive({
          _tag: "Request",
          id: 7,
          tag: "test.duplicate",
          payload: {},
          headers: [],
        }),
      ),
      RpcBridgeSessionError,
    );
  });
});

test("treats browser Eof as session-local cleanup", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const first = await Effect.runPromise(bridge.attach(fakeTransport()));
    await Effect.runPromise(
      first.receive({
        _tag: "Request",
        id: 1,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );
    const helperId = (helper.sent[0] as { readonly id: string }).id;
    await Effect.runPromise(first.receive({ _tag: "Eof" }));
    assert.deepEqual(helper.sent[1], { _tag: "Interrupt", requestId: helperId });
    assert.equal(
      helper.sent.some((message) => (message as { readonly _tag?: string })._tag === "Eof"),
      false,
    );
    await Effect.runPromise(bridge.attach(fakeTransport()));
  });
});

test("rejects a concurrent browser session", async () => {
  await withBridge(async ({ bridge }) => {
    await Effect.runPromise(bridge.attach(fakeTransport()));
    await assert.rejects(Effect.runPromise(bridge.attach(fakeTransport())), RpcBridgeConflictError);
  });
});

test("closes the helper when detached requests do not acknowledge interruption", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const session = await Effect.runPromise(bridge.attach(fakeTransport()));
    await Effect.runPromise(
      session.receive({
        _tag: "Request",
        id: 1,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );
    await Effect.runPromise(session.close);
    await eventually(() => assert.equal(helper.closeCount(), 1));
  }, 5);
});

test("does not close the helper when detached requests acknowledge interruption", async () => {
  await withBridge(async ({ bridge, helper }) => {
    const session = await Effect.runPromise(bridge.attach(fakeTransport()));
    await Effect.runPromise(
      session.receive({
        _tag: "Request",
        id: 1,
        tag: "test.stream",
        payload: {},
        headers: [],
      }),
    );
    const helperId = (helper.sent[0] as { readonly id: string }).id;
    await Effect.runPromise(session.close);
    helper.emit({
      _tag: "Exit",
      requestId: helperId,
      exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(helper.closeCount(), 0);
  }, 5);
});
