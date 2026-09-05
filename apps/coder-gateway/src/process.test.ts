// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";

import * as Effect from "effect/Effect";

import { runGatewayProcess } from "./process.ts";

function makeProcess(onKill?: (signal: NodeJS.Signals) => void): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      onKill?.(signal);
      return true;
    },
  });
  return child as unknown as ChildProcess;
}

describe("gateway child processes", () => {
  it("hides background processes on Windows while allowing interactive login", async () => {
    const windowsHideValues: Array<boolean | undefined> = [];
    const spawnProcess = (_executable: string, _args: readonly string[], options: SpawnOptions) => {
      strictEqual(options.shell, false);
      windowsHideValues.push(options.windowsHide);
      const child = makeProcess();
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };

    await Effect.runPromise(
      runGatewayProcess(
        { executable: "coder", args: [] },
        { label: "Background Coder", spawnProcess },
      ),
    );
    await Effect.runPromise(
      runGatewayProcess(
        { executable: "coder", args: [] },
        { label: "Coder login", windowsHide: false, spawnProcess },
      ),
    );

    deepStrictEqual(windowsHideValues, [true, false]);
  });

  it("preserves signal exits", async () => {
    const child = makeProcess();
    const result = Effect.runPromise(
      runGatewayProcess(
        { executable: "coder", args: [] },
        {
          label: "Coder command",
          spawnProcess: () => {
            setImmediate(() => child.emit("exit", null, "SIGTERM"));
            return child;
          },
        },
      ),
    );

    strictEqual((await result).signal, "SIGTERM");
  });

  it("reports a missing Coder executable without exposing ENOENT jargon", async () => {
    await rejects(
      Effect.runPromise(
        runGatewayProcess(
          { executable: "/missing/coder", args: [] },
          {
            label: "Coder workspace discovery",
            spawnProcess: () => {
              const cause = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
              throw cause;
            },
          },
        ),
      ),
      /Coder executable does not exist: \/missing\/coder\./u,
    );
  });

  it("escalates a timed-out process and waits for exit", async () => {
    const killSignals: NodeJS.Signals[] = [];
    let child: ChildProcess;
    child = makeProcess((signal) => {
      killSignals.push(signal);
      if (signal === "SIGKILL") setImmediate(() => child.emit("exit", null, signal));
    });

    await rejects(
      Effect.runPromise(
        runGatewayProcess(
          { executable: "coder", args: [] },
          {
            label: "Coder command",
            timeoutMs: 10,
            terminationGraceMs: 10,
            spawnProcess: () => child,
          },
        ),
      ),
      /Coder command timed out/u,
    );

    deepStrictEqual(killSignals, ["SIGTERM", "SIGKILL"]);
  });
});
