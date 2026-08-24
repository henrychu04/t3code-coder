// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { connectCoderWorkspacePing, parseCoderPingLatencyMs } from "./workspacePing.ts";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  };
  return child;
}

describe("Coder workspace ping process", () => {
  it("parses Coder pong durations", () => {
    strictEqual(parseCoderPingLatencyMs("pong from dev proxied via DERP(New York) in 42ms"), 42);
    strictEqual(
      parseCoderPingLatencyMs("pong from dev proxied via DERP(New York) in 1.25s"),
      1_250,
    );
    strictEqual(
      parseCoderPingLatencyMs(
        "\u001b[32mpong from dev proxied via DERP(New York) in 850µs\u001b[0m",
      ),
      0.85,
    );
    strictEqual(parseCoderPingLatencyMs('ping to "dev" timed out'), null);
  });

  it("streams the latest pong and stops the exact child with its scope", async () => {
    const child = fakeChild();
    let spawnInput: unknown;
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const connection = await Effect.runPromise(
      connectCoderWorkspacePing(
        { executable: "coder", args: ["ping", "workspace"] },
        {
          spawnProcess: (executable, args, options) => {
            spawnInput = { executable, args, options };
            queueMicrotask(() => child.emit("spawn"));
            return child as unknown as ChildProcess;
          },
        },
      ).pipe(Scope.provide(scope)),
    );
    deepStrictEqual(spawnInput, {
      executable: "coder",
      args: ["ping", "workspace"],
      options: {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });

    child.stdout.write("diagnostic output\npong from workspace proxied via DERP(test) in ");
    strictEqual(connection.latestLatencyMs(), null);
    child.stdout.write("31ms\npong from workspace proxied via DERP(test) in 29ms\n");
    strictEqual(connection.latestLatencyMs(), 29);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    deepStrictEqual(await Effect.runPromise(connection.closed), {
      code: null,
      signal: "SIGTERM",
      expected: true,
    });
  });
});
