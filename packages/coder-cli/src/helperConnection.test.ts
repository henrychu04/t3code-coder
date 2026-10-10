// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as NodeFS from "node:fs/promises";
import { describe, it } from "node:test";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerSettings,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  CoderHelperInstallRequiredError,
  connectCoderHelper as connectCoderHelperEffect,
  isExpectedCoderHelperExit,
} from "./helperConnection.ts";
import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION } from "./rpc.ts";

const helperPath = fileURLToPath(new URL("../../../apps/coder-helper/src/bin.ts", import.meta.url));
const encodedDefaultServerSettings = Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS);

async function connectCoderHelper(...args: Parameters<typeof connectCoderHelperEffect>) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  try {
    const connection = await Effect.runPromise(
      connectCoderHelperEffect(...args).pipe(Scope.provide(scope)),
    );
    const closed = Effect.runPromise(connection.closed);
    void closed
      .then(
        () => Effect.runPromise(Scope.close(scope, Exit.void)),
        () => Effect.runPromise(Scope.close(scope, Exit.void)),
      )
      .catch(() => undefined);
    return {
      ...connection,
      closed,
      sendRpc: (message: unknown) => Effect.runSync(connection.sendRpc(message)),
      close: () => {
        void Effect.runPromise(connection.close).catch(() => undefined);
      },
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  }
}

function makeFakeHelperProcess(options?: { readonly ignoreSigterm?: boolean }) {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killSignals: NodeJS.Signals[] = [];
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: 1,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      killSignals.push(signal);
      if (signal === "SIGTERM" && options?.ignoreSigterm) return true;
      queueMicrotask(() => events.emit("exit", null, signal));
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;

  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    let newline = input.indexOf("\n");
    while (newline !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const request = JSON.parse(line) as { readonly id: string };
      if (request.id === "gateway-info") {
        queueMicrotask(() =>
          stdout.write(
            `${JSON.stringify({
              _tag: "Exit",
              requestId: "gateway-info",
              exit: {
                _tag: "Success",
                value: {
                  protocolVersion: CODER_HELPER_PROTOCOL_VERSION,
                  platform: "linux",
                  architecture: "x64",
                },
              },
            })}\n`,
          ),
        );
      } else if (request.id === "gateway-config") {
        queueMicrotask(() =>
          stdout.write(
            `${JSON.stringify({
              _tag: "Exit",
              requestId: "gateway-config",
              exit: {
                _tag: "Success",
                value: {
                  environment: {
                    environmentId: EnvironmentId.make("environment-test"),
                    label: TrimmedNonEmptyString.make("Coder workspace"),
                    platform: { os: "linux", arch: "x64" },
                    serverVersion: TrimmedNonEmptyString.make("0.0.33"),
                    capabilities: { repositoryIdentity: true },
                  },
                  cwd: "/workspace",
                  keybindingsConfigPath: "/workspace/keybindings.json",
                  keybindings: [],
                  issues: [],
                  providers: [],
                  settings: encodedDefaultServerSettings,
                },
              },
            })}\n`,
          ),
        );
      }
      newline = input.indexOf("\n");
    }
  });

  return { child, stdin, stdout, killSignals };
}

describe("Coder helper connection", () => {
  it("negotiates with the foreground helper and closes with the pipe", async () => {
    const helperHome = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-helper-"));
    const connection = await connectCoderHelper(
      {
        executable: process.execPath,
        args: [helperPath],
      },
      { environment: { ...process.env, T3_CODER_HOME: helperHome } },
    );
    strictEqual(connection.info.protocolVersion, CODER_HELPER_PROTOCOL_VERSION);
    strictEqual(connection.info.platform, process.platform);
    strictEqual(connection.info.architecture, process.arch);

    const rpcResponse = new Promise<unknown>((resolve) => {
      const unsubscribe = connection.onRpcMessage((message) => {
        unsubscribe();
        resolve(message);
      });
    });
    connection.sendRpc({
      _tag: "Request",
      id: "second-info",
      tag: CODER_HELPER_INFO_METHOD,
      payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
      headers: [],
    });
    deepStrictEqual(await rpcResponse, {
      _tag: "Exit",
      requestId: "second-info",
      exit: {
        _tag: "Success",
        value: {
          protocolVersion: CODER_HELPER_PROTOCOL_VERSION,
          platform: process.platform,
          architecture: process.arch,
        },
      },
    });

    connection.close();
    strictEqual((await connection.closed).expected, true);
    // Provider probe children can finish writing to HOME just after the helper exits.
    await NodeFS.rm(helperHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("waits for remote terminal setup before sending negotiation data", async () => {
    const fake = makeFakeHelperProcess();
    const connectionPromise = connectCoderHelper(
      { executable: "coder", args: [] },
      {
        readySentinel: "T3_CODER_HELPER_READY",
        spawnProcess: () => fake.child,
        negotiationTimeoutMs: 1_000,
      },
    );

    fake.stdout.write('remote login banner\n{"echoed":"shell output"}\n');
    fake.stdout.write("T3_CODER_HELPER_READY\n");

    const connection = await connectionPromise;
    strictEqual(connection.info.protocolVersion, CODER_HELPER_PROTOCOL_VERSION);
    connection.close();
    strictEqual((await connection.closed).expected, true);
  });

  it("reports the workspace preflight failure the launch prints", async () => {
    const fake = makeFakeHelperProcess();
    const connectionPromise = connectCoderHelper(
      { executable: "coder", args: [] },
      { readySentinel: "T3_CODER_HELPER_READY", spawnProcess: () => fake.child },
    );
    fake.stdout.write("motd\r\nT3_CODER_PREFLIGHT_FAILED: T3 Coder requires Git.\r\n");
    await rejects(connectionPromise, /^CoderHelperConnectionError: T3 Coder requires Git\.$/u);
    deepStrictEqual(fake.killSignals, ["SIGTERM"]);
  });

  it("asks for a helper install when the installed bundle differs", async () => {
    const fake = makeFakeHelperProcess();
    const connectionPromise = connectCoderHelper(
      { executable: "coder", args: [] },
      { readySentinel: "T3_CODER_HELPER_READY", spawnProcess: () => fake.child },
    );
    fake.stdout.write("T3_CODER_HELPER_INSTALL_REQUIRED\n");
    await rejects(connectionPromise, (error) => error instanceof CoderHelperInstallRequiredError);
  });

  it("times the preflight separately from helper negotiation", async () => {
    const slowPreflight = makeFakeHelperProcess();
    await rejects(
      connectCoderHelper(
        { executable: "coder", args: [] },
        {
          readySentinel: "T3_CODER_HELPER_READY",
          spawnProcess: () => slowPreflight.child,
          preflightTimeoutMs: 20,
          negotiationTimeoutMs: 1_000,
        },
      ),
      /preflight timed out/u,
    );

    const fake = makeFakeHelperProcess();
    let readyCalls = 0;
    const connectionPromise = connectCoderHelper(
      { executable: "coder", args: [] },
      {
        readySentinel: "T3_CODER_HELPER_READY",
        spawnProcess: () => fake.child,
        preflightTimeoutMs: 1_000,
        negotiationTimeoutMs: 1_000,
        onReady: () => {
          readyCalls += 1;
        },
      },
    );
    // A preflight slower than the negotiation timeout is fine while within its own budget.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.stdout.write("T3_CODER_HELPER_READY\n");
    const connection = await connectionPromise;
    strictEqual(readyCalls, 1);
    connection.close();
    await connection.closed;
  });

  it("reassembles a large frame split across chunks and multibyte boundaries", async () => {
    const fake = makeFakeHelperProcess();
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
    );
    const received = new Promise<unknown>((resolve) => connection.onRpcMessage(resolve));
    const value = `${"é".repeat(2 * 1024 * 1024)}🚀`;
    const frame = Buffer.from(`${JSON.stringify({ _tag: "Chunk", value })}\n`, "utf8");
    // 4 KiB chunks start inside a multibyte character every time.
    for (let offset = 0; offset < frame.byteLength; offset += 4097) {
      fake.stdout.write(frame.subarray(offset, offset + 4097));
    }
    deepStrictEqual(await received, { _tag: "Chunk", value });
    connection.close();
    strictEqual((await connection.closed).expected, true);
  });

  it("reports stdin backpressure until the helper drains its input", async () => {
    const fake = makeFakeHelperProcess();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const connection = await Effect.runPromise(
      connectCoderHelperEffect(
        { executable: "coder", args: [] },
        { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
      ).pipe(Scope.provide(scope)),
    );
    try {
      await Effect.runPromise(connection.drained);
      strictEqual(connection.needsDrain(), false);
      fake.stdin.pause();
      await Effect.runPromise(
        connection.sendRpc({ _tag: "Ping", padding: "x".repeat(256 * 1024) }),
      );
      let drained = false;
      strictEqual(connection.needsDrain(), true);
      const writable = Effect.runPromise(connection.drained).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      strictEqual(drained, false);
      fake.stdin.resume();
      await writable;
      strictEqual(drained, true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("treats Effect's stdin interruption exit as a normal disconnect", () => {
    strictEqual(isExpectedCoderHelperExit(130, null, false), true);
    strictEqual(isExpectedCoderHelperExit(1, null, false), false);
  });

  it("reports a missing Coder executable during connection", async () => {
    await rejects(
      connectCoderHelper(
        { executable: "t3-coder-missing-executable-for-test", args: [] },
        { negotiationTimeoutMs: 1_000 },
      ),
      /ENOENT/,
    );
  });

  it("marks malformed post-negotiation output as an unexpected protocol failure", async () => {
    const fake = makeFakeHelperProcess();
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
    );

    fake.stdout.write("not-json\n");

    deepStrictEqual(await connection.closed, {
      code: null,
      signal: "SIGTERM",
      expected: false,
      reason: "Coder helper emitted a malformed RPC message.",
    });
  });

  it("isolates throwing RPC listeners without closing the helper connection", async () => {
    const fake = makeFakeHelperProcess();
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
    );
    connection.onRpcMessage(() => {
      throw new Error("consumer failed");
    });
    const received = new Promise<unknown>((resolve) => {
      connection.onRpcMessage(resolve);
    });

    fake.stdout.write(`${JSON.stringify({ _tag: "RpcEvent", value: 1 })}\n`);

    deepStrictEqual(await received, { _tag: "RpcEvent", value: 1 });
    connection.close();
    strictEqual((await connection.closed).expected, true);
  });

  it("marks oversized post-negotiation output as an unexpected protocol failure", async () => {
    const fake = makeFakeHelperProcess();
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
    );

    fake.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 1));

    strictEqual((await connection.closed).reason, "Coder helper emitted an oversized RPC message.");
  });

  it("routes a post-negotiation stdin error through the unexpected failure path", async () => {
    const fake = makeFakeHelperProcess();
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
    );

    fake.stdin.emit("error", new Error("EPIPE"));

    strictEqual((await connection.closed).expected, false);
  });

  it("force-kills a helper that ignores graceful connection shutdown", async () => {
    const fake = makeFakeHelperProcess({ ignoreSigterm: true });
    const connection = await connectCoderHelper(
      { executable: "coder", args: [] },
      {
        spawnProcess: () => fake.child,
        negotiationTimeoutMs: 1_000,
        terminationGraceMs: 10,
      },
    );

    connection.close();

    strictEqual((await connection.closed).expected, true);
    deepStrictEqual(fake.killSignals, ["SIGTERM", "SIGKILL"]);
  });

  it("terminates the helper when its owning Effect scope closes", async () => {
    const fake = makeFakeHelperProcess();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const connection = await Effect.runPromise(
      connectCoderHelperEffect(
        { executable: "coder", args: [] },
        { spawnProcess: () => fake.child, negotiationTimeoutMs: 1_000 },
      ).pipe(Scope.provide(scope)),
    );
    const closed = Effect.runPromise(connection.closed);

    await Effect.runPromise(Scope.close(scope, Exit.void));

    strictEqual((await closed).expected, true);
    deepStrictEqual(fake.killSignals, ["SIGTERM"]);
  });
});

it("does not hide a failed helper stop and retries the captured process", async () => {
  const { child } = makeFakeHelperProcess();
  const originalKill = child.kill.bind(child);
  child.kill = () => false;
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const connection = await Effect.runPromise(
    connectCoderHelperEffect(
      { executable: "coder", args: [] },
      {
        spawnProcess: () => child,
        terminationGraceMs: 5,
      },
    ).pipe(Scope.provide(scope)),
  );
  try {
    await rejects(Effect.runPromise(connection.close), /shutdown was not confirmed/);
    child.kill = originalKill;
    await Effect.runPromise(connection.close);
  } finally {
    child.kill = originalKill;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
