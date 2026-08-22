// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This is a Node child-process adapter, not an Effect runtime.
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import * as NodeTimers from "node:timers";

import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ServerConfig, WS_METHODS, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import type { CoderInvocation } from "./command.ts";
import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION, CoderHelperInfo } from "./rpc.ts";

const MAX_HELPER_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HELPER_ERROR_BYTES = 32 * 1024;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 60_000;

export interface CoderHelperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
}

export interface CoderHelperConnection {
  readonly info: CoderHelperInfo & { readonly environment: ExecutionEnvironmentDescriptor };
  readonly closed: Promise<CoderHelperExit>;
  readonly sendRpc: (message: unknown) => void;
  readonly onRpcMessage: (listener: (message: unknown) => void) => () => void;
  readonly close: () => void;
}

function parseServerConfigResponse(value: unknown): ServerConfig {
  if (
    !Predicate.isObject(value) ||
    value._tag !== "Exit" ||
    value.requestId !== "gateway-config" ||
    !Predicate.isObject(value.exit) ||
    value.exit._tag !== "Success"
  ) {
    throw new Error("Coder helper returned an invalid server configuration response.");
  }
  return Schema.decodeUnknownSync(ServerConfig)(value.exit.value);
}

type SpawnCoderProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export function isExpectedCoderHelperExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  closeRequested: boolean,
): boolean {
  return (
    closeRequested || code === 0 || code === 130 || signal === "SIGINT" || signal === "SIGTERM"
  );
}

function parseInfoResponse(value: unknown): CoderHelperInfo {
  if (
    !Predicate.isObject(value) ||
    value._tag !== "Exit" ||
    value.requestId !== "gateway-info" ||
    !Predicate.isObject(value.exit)
  ) {
    throw new Error("Coder helper returned an invalid negotiation response.");
  }
  if (value.exit._tag !== "Success") {
    throw new Error("Coder helper rejected protocol negotiation.");
  }
  return Schema.decodeUnknownSync(CoderHelperInfo)(value.exit.value);
}

export function connectCoderHelper(
  invocation: CoderInvocation,
  options?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly negotiationTimeoutMs?: number;
    readonly spawnProcess?: SpawnCoderProcess;
  },
): Promise<CoderHelperConnection> {
  const spawnProcess = options?.spawnProcess ?? spawn;
  const child = spawnProcess(invocation.executable, invocation.args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(options?.environment === undefined ? {} : { env: options.environment }),
  });
  let closeRequested = false;
  let stderr = "";
  const rpcListeners = new Set<(message: unknown) => void>();

  const closed = new Promise<CoderHelperExit>((resolve) => {
    child.once("exit", (code, signal) =>
      resolve({ code, signal, expected: isExpectedCoderHelperExit(code, signal, closeRequested) }),
    );
    child.once("error", () => resolve({ code: null, signal: null, expected: closeRequested }));
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length >= MAX_HELPER_ERROR_BYTES) return;
    stderr += chunk.toString("utf8").slice(0, MAX_HELPER_ERROR_BYTES - stderr.length);
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    let negotiated = false;
    let helperInfo: CoderHelperInfo | undefined;
    const timeout = NodeTimers.setTimeout(() => {
      fail(new Error("Timed out while negotiating with the Coder workspace helper."));
      child.kill();
    }, options?.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS);

    const cleanupNegotiation = () => {
      NodeTimers.clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onEarlyExit);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanupNegotiation();
      reject(cause);
    };
    const onError = (cause: Error) => fail(cause);
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = stderr.trim();
      fail(
        new Error(
          `Coder workspace helper exited before negotiation completed (code ${String(code)}, signal ${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
        ),
      );
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_LINE_BYTES) {
        fail(new Error("Coder helper negotiation response is too large."));
        child.kill();
        return;
      }
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line) as unknown;
          if (!negotiated) {
            if (helperInfo === undefined) {
              helperInfo = parseInfoResponse(message);
              child.stdin.write(
                `${JSON.stringify({
                  _tag: "Request",
                  id: "gateway-config",
                  tag: WS_METHODS.serverGetConfig,
                  payload: {},
                  headers: [],
                })}\n`,
              );
              newline = stdout.indexOf("\n");
              continue;
            }
            const serverConfig = parseServerConfigResponse(message);
            negotiated = true;
            settled = true;
            cleanupNegotiation();
            resolve({
              info: { ...helperInfo, environment: serverConfig.environment },
              closed,
              sendRpc: (rpcMessage) => {
                if (closeRequested || child.stdin.destroyed) {
                  throw new Error("Coder workspace helper is disconnected.");
                }
                const encoded = JSON.stringify(rpcMessage);
                if (Buffer.byteLength(encoded, "utf8") > MAX_HELPER_LINE_BYTES) {
                  throw new Error("Coder helper RPC request is too large.");
                }
                child.stdin.write(`${encoded}\n`);
              },
              onRpcMessage: (listener) => {
                rpcListeners.add(listener);
                return () => rpcListeners.delete(listener);
              },
              close: () => {
                if (closeRequested) return;
                closeRequested = true;
                child.stdin.end();
              },
            });
          } else {
            for (const listener of rpcListeners) listener(message);
          }
        } catch (cause) {
          fail(cause);
          child.kill();
          return;
        }
        newline = stdout.indexOf("\n");
      }
    };

    child.once("error", onError);
    child.once("exit", onEarlyExit);
    child.stdout.on("data", onStdout);
    child.stdin.write(
      `${JSON.stringify({
        _tag: "Request",
        id: "gateway-info",
        tag: CODER_HELPER_INFO_METHOD,
        payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
        headers: [],
      })}\n`,
    );
  });
}
