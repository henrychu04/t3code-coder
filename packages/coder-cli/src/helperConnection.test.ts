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

import { DEFAULT_SERVER_SETTINGS, EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { connectCoderHelper, isExpectedCoderHelperExit } from "./helperConnection.ts";
import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION } from "./rpc.ts";

const helperPath = fileURLToPath(new URL("../../../apps/coder-helper/src/bin.ts", import.meta.url));

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
                  settings: DEFAULT_SERVER_SETTINGS,
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
    await NodeFS.rm(helperHome, { recursive: true, force: true });
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
});
