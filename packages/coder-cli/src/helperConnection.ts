// @effect-diagnostics nodeBuiltinImport:off -- This module adapts Node child processes to Effect.
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import { ServerConfig, WS_METHODS, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { CoderInvocation } from "./command.ts";
import { CODER_HELPER_INFO_METHOD, CODER_HELPER_PROTOCOL_VERSION, CoderHelperInfo } from "./rpc.ts";

const MAX_HELPER_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HELPER_ERROR_BYTES = 32 * 1024;
const MAX_HELPER_PREAMBLE_BYTES = 32 * 1024;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export class CoderHelperConnectionError extends Error {
  readonly _tag = "CoderHelperConnectionError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderHelperConnectionError";
  }
}

export interface CoderHelperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly reason?: string;
}

export interface CoderHelperConnection {
  readonly info: CoderHelperInfo & { readonly environment: ExecutionEnvironmentDescriptor };
  readonly closed: Effect.Effect<CoderHelperExit>;
  readonly sendRpc: (message: unknown) => Effect.Effect<void, CoderHelperConnectionError>;
  readonly onRpcMessage: (listener: (message: unknown) => void) => () => void;
  readonly close: Effect.Effect<void>;
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

interface ManagedCoderProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Deferred.Deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
  }>;
  closeRequested: boolean;
  unexpectedExitReason: string | undefined;
  stderr: string;
}

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

const terminateCoderProcess = (
  process: ManagedCoderProcess,
  terminationGraceMs: number,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      process.closeRequested = true;
      process.child.stdin.end();
      if (Deferred.isDoneUnsafe(process.exit)) return Effect.void;

      process.child.kill("SIGTERM");
      return Deferred.await(process.exit).pipe(
        Effect.timeoutOption(terminationGraceMs),
        Effect.flatMap((exit) => {
          if (Option.isSome(exit)) return Effect.void;
          if (process.child.exitCode === null && process.child.signalCode === null) {
            process.child.kill("SIGKILL");
          }
          return Deferred.await(process.exit).pipe(Effect.asVoid);
        }),
      );
    }),
  ).pipe(Effect.catchCause(() => Effect.void));

function acquireCoderProcess(
  invocation: CoderInvocation,
  spawnProcess: SpawnCoderProcess,
  environment: NodeJS.ProcessEnv | undefined,
  terminationGraceMs: number,
): Effect.Effect<ManagedCoderProcess, CoderHelperConnectionError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const exit = yield* Deferred.make<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly error?: Error;
      }>();
      return yield* Effect.try({
        try: () => {
          const child = spawnProcess(invocation.executable, invocation.args, {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(environment === undefined ? {} : { env: environment }),
          });
          const process: ManagedCoderProcess = {
            child,
            exit,
            closeRequested: false,
            unexpectedExitReason: undefined,
            stderr: "",
          };
          child.once("exit", (code, signal) => {
            Deferred.doneUnsafe(process.exit, Effect.succeed({ code, signal }));
          });
          child.once("error", (error) => {
            Deferred.doneUnsafe(process.exit, Effect.succeed({ code: null, signal: null, error }));
          });
          child.stderr.on("data", (chunk: Buffer) => {
            if (process.stderr.length >= MAX_HELPER_ERROR_BYTES) return;
            process.stderr += chunk
              .toString("utf8")
              .slice(0, MAX_HELPER_ERROR_BYTES - process.stderr.length);
          });
          return process;
        },
        catch: (cause) =>
          new CoderHelperConnectionError("Coder workspace helper could not start.", { cause }),
      });
    }),
    (process) => terminateCoderProcess(process, terminationGraceMs),
  );
}

export function connectCoderHelper(
  invocation: CoderInvocation,
  options?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly negotiationTimeoutMs?: number;
    readonly readySentinel?: string;
    readonly spawnProcess?: SpawnCoderProcess;
    readonly terminationGraceMs?: number;
  },
): Effect.Effect<CoderHelperConnection, CoderHelperConnectionError, Scope.Scope> {
  return Effect.gen(function* () {
    const terminationGraceMs = options?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const process = yield* acquireCoderProcess(
      invocation,
      options?.spawnProcess ?? spawn,
      options?.environment,
      terminationGraceMs,
    );
    const { child } = process;
    const rpcListeners = new Set<(message: unknown) => void>();
    const runFork = yield* FiberSet.makeRuntime<never, void, never>();

    const connection = yield* Effect.callback<CoderHelperConnection, CoderHelperConnectionError>(
      (resume) => {
        let stdout = "";
        let settled = false;
        let negotiated = false;
        let ready = options?.readySentinel === undefined;
        let preambleBytes = 0;
        let helperInfo: CoderHelperInfo | undefined;

        const cleanupNegotiation = () => {
          child.off("error", onError);
          child.off("exit", onEarlyExit);
        };
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanupNegotiation();
          resume(
            Effect.fail(
              cause instanceof CoderHelperConnectionError
                ? cause
                : new CoderHelperConnectionError(
                    cause instanceof Error
                      ? cause.message
                      : "Coder workspace helper negotiation failed.",
                    { cause },
                  ),
            ),
          );
        };
        const terminateForFailure = (reason: string, cause?: unknown): void => {
          if (process.closeRequested) return;
          if (negotiated) {
            process.unexpectedExitReason = reason;
          } else {
            fail(cause ?? new Error(reason));
          }
          runFork(terminateCoderProcess(process, terminationGraceMs));
        };
        const onError = (cause: Error) => fail(cause);
        const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
          const detail = process.stderr.trim();
          fail(
            new Error(
              `Coder workspace helper exited before negotiation completed (code ${String(code)}, signal ${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
            ),
          );
        };
        const writeInfoRequest = () => {
          child.stdin.write(
            `${JSON.stringify({
              _tag: "Request",
              id: "gateway-info",
              tag: CODER_HELPER_INFO_METHOD,
              payload: { protocolVersion: CODER_HELPER_PROTOCOL_VERSION },
              headers: [],
            })}\n`,
          );
        };
        const onStdout = (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_LINE_BYTES) {
            terminateForFailure(
              negotiated
                ? "Coder helper emitted an oversized RPC message."
                : "Coder helper negotiation response is too large.",
            );
            return;
          }
          let newline = stdout.indexOf("\n");
          while (newline !== -1) {
            const line = stdout.slice(0, newline);
            stdout = stdout.slice(newline + 1);
            if (!ready) {
              preambleBytes += Buffer.byteLength(line, "utf8") + 1;
              if (preambleBytes > MAX_HELPER_PREAMBLE_BYTES) {
                terminateForFailure("Coder helper readiness preamble is too large.");
                return;
              }
              if (line.trimEnd() === options?.readySentinel) {
                ready = true;
                writeInfoRequest();
              }
              newline = stdout.indexOf("\n");
              continue;
            }
            let message: unknown;
            try {
              message = JSON.parse(line) as unknown;
            } catch (cause) {
              terminateForFailure(
                negotiated
                  ? "Coder helper emitted a malformed RPC message."
                  : "Coder helper returned an invalid negotiation response.",
                cause,
              );
              return;
            }
            if (!negotiated) {
              try {
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
                resume(
                  Effect.succeed({
                    info: { ...helperInfo, environment: serverConfig.environment },
                    closed: Deferred.await(process.exit).pipe(
                      Effect.map(({ code, signal }) => ({
                        code,
                        signal,
                        expected:
                          process.unexpectedExitReason === undefined &&
                          isExpectedCoderHelperExit(code, signal, process.closeRequested),
                        ...(process.unexpectedExitReason === undefined
                          ? {}
                          : { reason: process.unexpectedExitReason }),
                      })),
                    ),
                    sendRpc: (rpcMessage) =>
                      Effect.try({
                        try: () => {
                          if (
                            process.closeRequested ||
                            child.stdin.destroyed ||
                            child.stdin.writableEnded
                          ) {
                            throw new Error("Coder workspace helper is disconnected.");
                          }
                          const encoded = JSON.stringify(rpcMessage);
                          if (Buffer.byteLength(encoded, "utf8") > MAX_HELPER_LINE_BYTES) {
                            throw new Error("Coder helper RPC request is too large.");
                          }
                          child.stdin.write(`${encoded}\n`);
                        },
                        catch: (cause) =>
                          new CoderHelperConnectionError(
                            cause instanceof Error
                              ? cause.message
                              : "Coder helper RPC request failed.",
                            { cause },
                          ),
                      }),
                    onRpcMessage: (listener) => {
                      rpcListeners.add(listener);
                      return () => rpcListeners.delete(listener);
                    },
                    close: terminateCoderProcess(process, terminationGraceMs),
                  }),
                );
              } catch (cause) {
                terminateForFailure(
                  "Coder helper returned an invalid negotiation response.",
                  cause,
                );
                return;
              }
            } else {
              for (const listener of rpcListeners) {
                try {
                  listener(message);
                } catch {
                  // A consumer failure must not be misclassified as malformed helper RPC.
                }
              }
            }
            newline = stdout.indexOf("\n");
          }
        };
        const onStdinError = (cause: Error) => {
          terminateForFailure("Coder workspace helper stdin failed.", cause);
        };

        child.once("error", onError);
        child.once("exit", onEarlyExit);
        child.stdin.on("error", onStdinError);
        child.stdout.on("data", onStdout);
        if (ready) writeInfoRequest();

        return Effect.sync(() => {
          cleanupNegotiation();
          child.stdin.off("error", onStdinError);
          child.stdout.off("data", onStdout);
        });
      },
    ).pipe(
      Effect.timeoutOrElse({
        duration: options?.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new CoderHelperConnectionError(
              "Timed out while negotiating with the Coder workspace helper.",
            ),
          ),
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rpcListeners.clear();
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.stdin.removeAllListeners("error");
      }),
    );
    return connection;
  });
}
