// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual, rejects } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

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
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const connection = await Effect.runPromise(
        connectCoderPortForward(
          { executable: "coder", args: ["port-forward", "workspace"] },
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
        args: ["port-forward", "workspace"],
        options: {
          shell: false,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      });

      await Effect.runPromise(connection.close);
      deepStrictEqual(await Effect.runPromise(connection.closed), {
        code: null,
        signal: "SIGTERM",
        expected: true,
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("keeps bounded stderr detail for unexpected exits", async () => {
    const child = fakeChild();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const connection = await Effect.runPromise(
        connectCoderPortForward(
          { executable: "coder", args: ["port-forward", "workspace"] },
          {
            spawnProcess: () => {
              queueMicrotask(() => child.emit("spawn"));
              return child as unknown as ChildProcess;
            },
          },
        ).pipe(Scope.provide(scope)),
      );
      child.stderr.write("local port is already in use");
      child.exitCode = 1;
      child.emit("exit", 1, null);
      const exit = await Effect.runPromise(connection.closed);
      strictEqual(exit.expected, false);
      match(exit.reason ?? "", /local port is already in use/u);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("force-kills a forward that ignores graceful scope shutdown", async () => {
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    child.kill = (signal = "SIGTERM") => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }
      return true;
    };
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      connectCoderPortForward(
        { executable: "coder", args: ["port-forward", "workspace"] },
        {
          spawnProcess: () => {
            queueMicrotask(() => child.emit("spawn"));
            return child as unknown as ChildProcess;
          },
          terminationGraceMs: 10,
        },
      ).pipe(Scope.provide(scope)),
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));

    deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
  });
});

it("reports an unconfirmed stop and allows retrying the same child", async () => {
  const child = fakeChild();
  const originalKill = child.kill;
  child.kill = () => false;
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const connection = await Effect.runPromise(
    connectCoderPortForward(
      { executable: "coder", args: [] },
      {
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
        terminationGraceMs: 5,
      },
    ).pipe(Scope.provide(scope)),
  );
  try {
    await rejects(Effect.runPromise(connection.close), /shutdown was not confirmed/);
    strictEqual(child.listenerCount("exit"), 1);
    child.kill = originalKill;
    await Effect.runPromise(connection.close);
    strictEqual((await Effect.runPromise(connection.closed)).expected, true);
  } finally {
    child.kill = originalKill;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
it("escalates a thrown graceful signal without falsely reporting exit", async () => {
  const child = fakeChild();
  const originalKill = child.kill;
  child.kill = (signal) => {
    if (signal === "SIGTERM") throw new Error("signal rejected");
    return originalKill(signal);
  };
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const connection = await Effect.runPromise(
    connectCoderPortForward(
      { executable: "coder", args: [] },
      {
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
        terminationGraceMs: 5,
      },
    ).pipe(Scope.provide(scope)),
  );
  try {
    await Effect.runPromise(connection.close);
    strictEqual((await Effect.runPromise(connection.closed)).signal, "SIGKILL");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it("does not treat a kill error event as process exit", async () => {
  const child = fakeChild();
  const originalKill = child.kill;
  child.kill = (signal) => {
    if (signal === "SIGTERM") {
      child.emit("error", new Error("kill rejected"));
      return false;
    }
    return originalKill(signal);
  };
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const connection = await Effect.runPromise(
    connectCoderPortForward(
      { executable: "coder", args: [] },
      {
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
        terminationGraceMs: 5,
      },
    ).pipe(Scope.provide(scope)),
  );
  try {
    await Effect.runPromise(connection.close);
    strictEqual((await Effect.runPromise(connection.closed)).signal, "SIGKILL");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

for (const exitsAfterSignal of [false, true]) {
  it(`waits for exit confirmation after SIGKILL throws (exits: ${exitsAfterSignal})`, async () => {
    const child = fakeChild();
    const originalKill = child.kill;
    child.kill = (signal) => {
      if (signal === "SIGKILL") {
        if (exitsAfterSignal) {
          setImmediate(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          });
        }
        throw new Error("signal rejected");
      }
      return false;
    };
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const connection = await Effect.runPromise(
      connectCoderPortForward(
        { executable: "coder", args: [] },
        {
          spawnProcess: () => {
            queueMicrotask(() => child.emit("spawn"));
            return child as unknown as ChildProcess;
          },
          terminationGraceMs: 10,
        },
      ).pipe(Scope.provide(scope)),
    );
    try {
      if (exitsAfterSignal) {
        await Effect.runPromise(connection.close);
        strictEqual((await Effect.runPromise(connection.closed)).expected, true);
      } else {
        await rejects(Effect.runPromise(connection.close), /shutdown was not confirmed/);
        strictEqual(child.listenerCount("exit"), 1);
      }
    } finally {
      child.kill = originalKill;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
}
