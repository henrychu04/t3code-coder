// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import { connectCoderPortForward } from "./portForward.ts";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
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

describe("Coder port forward process", () => {
  it("spawns without a shell and reports requested shutdown as expected", async () => {
    const child = fakeChild();
    let spawnInput: unknown;
    const connecting = connectCoderPortForward(
      { executable: "coder", args: ["port-forward", "workspace"] },
      {
        spawnProcess: (executable, args, options) => {
          spawnInput = { executable, args, options };
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
      },
    );
    const connection = await connecting;
    deepStrictEqual(spawnInput, {
      executable: "coder",
      args: ["port-forward", "workspace"],
      options: {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    });

    connection.close();
    deepStrictEqual(await connection.closed, {
      code: null,
      signal: "SIGTERM",
      expected: true,
    });
  });

  it("keeps bounded stderr detail for unexpected exits", async () => {
    const child = fakeChild();
    const connecting = connectCoderPortForward(
      { executable: "coder", args: ["port-forward", "workspace"] },
      {
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
      },
    );
    const connection = await connecting;
    child.stderr.write("local port is already in use");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    const exit = await connection.closed;
    strictEqual(exit.expected, false);
    match(exit.reason ?? "", /local port is already in use/u);
  });
});
