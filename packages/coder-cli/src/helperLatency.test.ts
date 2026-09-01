// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { CoderHelperConnection } from "./helperConnection.ts";
import { CoderHelperConnectionError } from "./helperConnection.ts";
import { CoderHelperLatencyError, measureCoderHelperLatency } from "./helperLatency.ts";

function fakeHelperConnection(repliesOnSend: readonly unknown[] = []) {
  const listeners = new Set<(message: unknown) => void>();
  const sent: unknown[] = [];
  const emit = (message: unknown): void => {
    for (const listener of [...listeners]) listener(message);
  };
  return {
    sendRpc: (message: unknown) =>
      Effect.sync(() => {
        sent.push(message);
        for (const reply of repliesOnSend) emit(reply);
      }),
    onRpcMessage: (listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit,
    sent,
    listenerCount: () => listeners.size,
  } satisfies Pick<CoderHelperConnection, "sendRpc" | "onRpcMessage"> & {
    readonly emit: (message: unknown) => void;
    readonly sent: unknown[];
    readonly listenerCount: () => number;
  };
}

describe("Coder helper latency measurement", () => {
  it("sends one protocol ping and times the first pong", async () => {
    const helper = fakeHelperConnection([{ _tag: "Pong" }]);
    const result = await Effect.runPromise(
      Effect.result(measureCoderHelperLatency(helper, { timeoutMs: 1_000 })),
    );
    strictEqual(Result.isSuccess(result), true);
    if (Result.isSuccess(result)) {
      strictEqual(result.success.latencyMs >= 0, true);
      strictEqual(typeof result.success.sampledAt, "number");
    }
    deepStrictEqual(helper.sent, [{ _tag: "Ping" }]);
    strictEqual(helper.listenerCount(), 0);
  });

  it("ignores non-pong helper messages while measuring", async () => {
    const helper = fakeHelperConnection([
      { _tag: "Chunk", requestId: "browser:0", chunk: {} },
      { _tag: "Pong" },
      { _tag: "Pong" },
    ]);
    const result = await Effect.runPromise(
      Effect.result(measureCoderHelperLatency(helper, { timeoutMs: 1_000 })),
    );
    strictEqual(Result.isSuccess(result), true);
    strictEqual(helper.listenerCount(), 0);
  });

  it("fails when the pong does not arrive before the timeout", async () => {
    const helper = fakeHelperConnection();
    const result = await Effect.runPromise(
      Effect.result(measureCoderHelperLatency(helper, { timeoutMs: 10 })),
    );
    strictEqual(Result.isFailure(result), true);
    if (Result.isFailure(result)) {
      strictEqual(result.failure instanceof CoderHelperLatencyError, true);
      strictEqual(result.failure.message.includes("Timed out"), true);
    }
    strictEqual(helper.listenerCount(), 0);
  });

  it("fails when the helper connection cannot accept the ping", async () => {
    const helper = {
      ...fakeHelperConnection(),
      sendRpc: () =>
        Effect.fail(
          new CoderHelperConnectionError("Coder workspace helper is disconnected."),
        ),
    };
    const result = await Effect.runPromise(
      Effect.result(measureCoderHelperLatency(helper, { timeoutMs: 1_000 })),
    );
    strictEqual(Result.isFailure(result), true);
    if (Result.isFailure(result)) {
      strictEqual(result.failure instanceof CoderHelperLatencyError, true);
      strictEqual(result.failure.message.includes("disconnected"), true);
    }
    strictEqual(helper.listenerCount(), 0);
  });

  it("measures a delayed pong against elapsed wall time", async () => {
    const base = fakeHelperConnection();
    const helper = {
      ...base,
      sendRpc: (message: unknown) => {
        setTimeout(() => base.emit({ _tag: "Pong" }), 30);
        return base.sendRpc(message);
      },
    };
    const result = await Effect.runPromise(
      Effect.result(measureCoderHelperLatency(helper, { timeoutMs: 5_000 })),
    );
    strictEqual(Result.isSuccess(result), true);
    if (Result.isSuccess(result)) {
      strictEqual(result.success.latencyMs >= 25, true);
    }
  });
});
