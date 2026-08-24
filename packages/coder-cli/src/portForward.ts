// @effect-diagnostics nodeBuiltinImport:off -- This module adapts Node child processes to Effect.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type { CoderInvocation } from "./command.ts";

const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export class CoderPortForwardError extends Error {
  readonly _tag = "CoderPortForwardError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderPortForwardError";
  }
}

export interface CoderPortForwardExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly reason?: string;
}

export interface CoderPortForwardConnection {
  readonly closed: Effect.Effect<CoderPortForwardExit>;
  readonly close: Effect.Effect<void>;
}

type SpawnCoderProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface ManagedPortForwardProcess {
  readonly child: ChildProcess;
  readonly spawned: Deferred.Deferred<void, CoderPortForwardError>;
  readonly exit: Deferred.Deferred<CoderPortForwardExit>;
  readonly cleanupListeners: () => void;
  closeRequested: boolean;
}

const terminatePortForwardProcess = (
  process: ManagedPortForwardProcess,
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

export function connectCoderPortForward(
  invocation: CoderInvocation,
  options?: {
    readonly spawnProcess?: SpawnCoderProcess;
    readonly terminationGraceMs?: number;
  },
): Effect.Effect<CoderPortForwardConnection, CoderPortForwardError, Scope.Scope> {
  const terminationGraceMs = options?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  return Effect.gen(function* () {
    const process = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void, CoderPortForwardError>();
        const exit = yield* Deferred.make<CoderPortForwardExit>();
        let stderr = "";
        const child = yield* Effect.try({
          try: () =>
            (options?.spawnProcess ?? spawn)(invocation.executable, invocation.args, {
              shell: false,
              stdio: ["ignore", "ignore", "pipe"],
              windowsHide: true,
            }),
          catch: (cause) =>
            new CoderPortForwardError("Coder port forward could not start.", { cause }),
        });
        const process: ManagedPortForwardProcess = {
          child,
          spawned,
          exit,
          closeRequested: false,
          cleanupListeners: () => {
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
              `Coder port forward exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`);
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
        const onStderr = (chunk: Buffer) => {
          if (stderr.length >= MAX_ERROR_BYTES) return;
          stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BYTES - stderr.length);
        };
        const onSpawn = () => Deferred.doneUnsafe(spawned, Effect.void);
        const onError = (cause: Error) => {
          const error = new CoderPortForwardError("Coder port forward could not start.", { cause });
          Deferred.doneUnsafe(spawned, Effect.fail(error));
          completeExit(null, null, cause);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          if (!Deferred.isDoneUnsafe(spawned)) {
            Deferred.doneUnsafe(
              spawned,
              Effect.fail(
                new CoderPortForwardError(
                  `Coder port forward exited before startup completed (code ${String(code)}, signal ${String(signal)}).`,
                ),
              ),
            );
          }
          completeExit(code, signal);
        };

        child.stderr?.on("data", onStderr);
        child.once("spawn", onSpawn);
        child.once("error", onError);
        child.once("exit", onExit);
        return process;
      }),
      (process) => terminatePortForwardProcess(process, terminationGraceMs),
    );

    yield* Deferred.await(process.spawned);
    return {
      closed: Deferred.await(process.exit),
      close: terminatePortForwardProcess(process, terminationGraceMs),
    };
  });
}
