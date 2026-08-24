// @effect-diagnostics nodeBuiltinImport:off -- This module adapts Node child processes to Effect.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type { CoderInvocation } from "./command.ts";

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_INCOMPLETE_LINE_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  "gu",
);
const PONG_LATENCY = /\bpong from .+ in (\d+(?:\.\d+)?)(ns|µs|us|ms|s)\s*$/u;

export class CoderWorkspacePingError extends Error {
  readonly _tag = "CoderWorkspacePingError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderWorkspacePingError";
  }
}

export interface CoderWorkspacePingExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly reason?: string;
}

export interface CoderWorkspacePingConnection {
  readonly closed: Effect.Effect<CoderWorkspacePingExit>;
  readonly close: Effect.Effect<void>;
  readonly latestLatencyMs: () => number | null;
}

type SpawnCoderProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface ManagedWorkspacePingProcess {
  readonly child: ChildProcess;
  readonly spawned: Deferred.Deferred<void, CoderWorkspacePingError>;
  readonly exit: Deferred.Deferred<CoderWorkspacePingExit>;
  readonly cleanupListeners: () => void;
  closeRequested: boolean;
  latestLatencyMs: number | null;
}

export function parseCoderPingLatencyMs(line: string): number | null {
  const match = ANSI_ESCAPE_SEQUENCE[Symbol.replace](line, "").match(PONG_LATENCY);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "ns":
      return value / 1_000_000;
    case "µs":
    case "us":
      return value / 1_000;
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    default:
      return null;
  }
}

const terminateWorkspacePingProcess = (
  process: ManagedWorkspacePingProcess,
  terminationGraceMs: number,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      process.closeRequested = true;
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
  ).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(Effect.sync(process.cleanupListeners)),
  );

export function connectCoderWorkspacePing(
  invocation: CoderInvocation,
  options?: {
    readonly spawnProcess?: SpawnCoderProcess;
    readonly terminationGraceMs?: number;
  },
): Effect.Effect<CoderWorkspacePingConnection, CoderWorkspacePingError, Scope.Scope> {
  const terminationGraceMs = options?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  return Effect.gen(function* () {
    const process = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void, CoderWorkspacePingError>();
        const exit = yield* Deferred.make<CoderWorkspacePingExit>();
        let stdoutRemainder = "";
        let stderr = "";
        const child = yield* Effect.try({
          try: () =>
            (options?.spawnProcess ?? spawn)(invocation.executable, invocation.args, {
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            }),
          catch: (cause) =>
            new CoderWorkspacePingError("Coder workspace ping could not start.", { cause }),
        });
        const process: ManagedWorkspacePingProcess = {
          child,
          spawned,
          exit,
          closeRequested: false,
          latestLatencyMs: null,
          cleanupListeners: () => {
            child.stdout?.off("data", onStdout);
            child.stderr?.off("data", onStderr);
            child.off("spawn", onSpawn);
            child.off("error", onError);
            child.off("exit", onExit);
          },
        };
        const completeExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
          cause?: Error,
        ) => {
          const detail = stderr.trim();
          const reason = process.closeRequested
            ? undefined
            : (cause?.message ??
              `Coder workspace ping exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`);
          Deferred.doneUnsafe(
            exit,
            Effect.succeed({
              code,
              signal,
              expected: process.closeRequested,
              ...(reason === undefined ? {} : { reason }),
            }),
          );
        };
        const readLine = (line: string) => {
          const latencyMs = parseCoderPingLatencyMs(line);
          if (latencyMs !== null) process.latestLatencyMs = latencyMs;
        };
        const onStdout = (chunk: Buffer) => {
          stdoutRemainder += chunk.toString("utf8");
          const lines = stdoutRemainder.split(/\r?\n/u);
          stdoutRemainder = lines.pop() ?? "";
          for (const line of lines) readLine(line);
          if (stdoutRemainder.length > MAX_INCOMPLETE_LINE_BYTES) stdoutRemainder = "";
        };
        const onStderr = (chunk: Buffer) => {
          if (stderr.length >= MAX_ERROR_BYTES) return;
          stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BYTES - stderr.length);
        };
        const onSpawn = () => Deferred.doneUnsafe(spawned, Effect.void);
        const onError = (cause: Error) => {
          const error = new CoderWorkspacePingError("Coder workspace ping could not start.", {
            cause,
          });
          Deferred.doneUnsafe(spawned, Effect.fail(error));
          completeExit(null, null, cause);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          if (!Deferred.isDoneUnsafe(spawned)) {
            Deferred.doneUnsafe(
              spawned,
              Effect.fail(
                new CoderWorkspacePingError(
                  `Coder workspace ping exited before startup completed (code ${String(code)}, signal ${String(signal)}).`,
                ),
              ),
            );
          }
          completeExit(code, signal);
        };

        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.once("spawn", onSpawn);
        child.once("error", onError);
        child.once("exit", onExit);
        return process;
      }),
      (process) => terminateWorkspacePingProcess(process, terminationGraceMs),
    );

    yield* Deferred.await(process.spawned);
    return {
      closed: Deferred.await(process.exit),
      close: terminateWorkspacePingProcess(process, terminationGraceMs),
      latestLatencyMs: () => process.latestLatencyMs,
    };
  });
}
