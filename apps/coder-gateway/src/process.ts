// @effect-diagnostics nodeBuiltinImport:off -- This module adapts Node child processes to Effect.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CoderInvocation } from "@t3tools/coder-cli/command";

export class GatewayProcessError extends Error {
  readonly _tag = "GatewayProcessError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayProcessError";
  }
}

export interface GatewayProcessOutput {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer<ArrayBufferLike>;
  readonly stderr: Buffer<ArrayBufferLike>;
}

type CaptureMode = "head" | "tail" | "error";
type SpawnGatewayProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface ManagedGatewayProcess {
  readonly child: ChildProcess;
  readonly exited: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<GatewayProcessOutput, GatewayProcessError>;
  readonly cleanupListeners: () => void;
}

function processLaunchError(
  label: string,
  executable: string,
  cause: unknown,
): GatewayProcessError {
  const message =
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
      ? `Coder executable does not exist: ${executable}.`
      : `${label} could not start.`;
  return new GatewayProcessError(message, { cause });
}

function appendOutput(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
  mode: CaptureMode,
): Buffer<ArrayBufferLike> | undefined {
  if (mode === "error" && current.byteLength + chunk.byteLength > maxBytes) return undefined;
  if (mode === "tail") {
    if (chunk.byteLength >= maxBytes) return chunk.subarray(chunk.byteLength - maxBytes);
    const overflow = current.byteLength + chunk.byteLength - maxBytes;
    return Buffer.concat([overflow > 0 ? current.subarray(overflow) : current, chunk]);
  }
  if (current.byteLength >= maxBytes) return current;
  return Buffer.concat([current, chunk.subarray(0, maxBytes - current.byteLength)]);
}

const terminateGatewayProcess = (
  process: ManagedGatewayProcess,
  terminationGraceMs: number,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (Deferred.isDoneUnsafe(process.exited)) return Effect.void;

      process.child.kill("SIGTERM");
      return Deferred.await(process.exited).pipe(
        Effect.timeoutOption(terminationGraceMs),
        Effect.flatMap((exit) => {
          if (Option.isSome(exit)) return Effect.void;
          if (process.child.exitCode === null && process.child.signalCode === null) {
            process.child.kill("SIGKILL");
          }
          return Deferred.await(process.exited);
        }),
      );
    }),
  ).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(Effect.sync(process.cleanupListeners)),
  );

export function runGatewayProcess(
  invocation: CoderInvocation,
  input: {
    readonly label: string;
    readonly timeoutMs?: number;
    readonly terminationGraceMs?: number;
    readonly stdin?: "inherit" | "ignore";
    readonly stdout?: "capture" | "inherit" | "ignore";
    readonly stderr?: "capture" | "inherit" | "ignore";
    readonly maxStdoutBytes?: number;
    readonly maxStderrBytes?: number;
    readonly stdoutMode?: CaptureMode;
    readonly stderrMode?: CaptureMode;
    readonly windowsHide?: boolean;
    readonly spawnProcess?: SpawnGatewayProcess;
  },
): Effect.Effect<GatewayProcessOutput, GatewayProcessError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const exited = yield* Deferred.make<void>();
          const completion = yield* Deferred.make<GatewayProcessOutput, GatewayProcessError>();
          let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          const child = yield* Effect.try({
            try: () =>
              (input.spawnProcess ?? spawn)(invocation.executable, invocation.args, {
                shell: false,
                detached: false,
                windowsHide: input.windowsHide ?? true,
                stdio: [
                  input.stdin === "inherit" ? "inherit" : "ignore",
                  input.stdout === "inherit"
                    ? "inherit"
                    : input.stdout === "ignore"
                      ? "ignore"
                      : "pipe",
                  input.stderr === "inherit"
                    ? "inherit"
                    : input.stderr === "ignore"
                      ? "ignore"
                      : "pipe",
                ],
              }),
            catch: (cause) => processLaunchError(input.label, invocation.executable, cause),
          });
          const onStdout = (chunk: Buffer) => {
            const next = appendOutput(
              stdout,
              chunk,
              input.maxStdoutBytes ?? 64 * 1024,
              input.stdoutMode ?? "head",
            );
            if (next === undefined) {
              Deferred.doneUnsafe(
                completion,
                Effect.fail(new GatewayProcessError(`${input.label} stdout is too large.`)),
              );
            } else {
              stdout = next;
            }
          };
          const onStderr = (chunk: Buffer) => {
            const next = appendOutput(
              stderr,
              chunk,
              input.maxStderrBytes ?? 64 * 1024,
              input.stderrMode ?? "head",
            );
            if (next === undefined) {
              Deferred.doneUnsafe(
                completion,
                Effect.fail(new GatewayProcessError(`${input.label} stderr is too large.`)),
              );
            } else {
              stderr = next;
            }
          };
          const onError = (cause: Error) => {
            if (child.pid === undefined) Deferred.doneUnsafe(exited, Effect.void);
            Deferred.doneUnsafe(
              completion,
              Effect.fail(processLaunchError(input.label, invocation.executable, cause)),
            );
          };
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            Deferred.doneUnsafe(exited, Effect.void);
            Deferred.doneUnsafe(completion, Effect.succeed({ code, signal, stdout, stderr }));
          };

          child.stdout?.on("data", onStdout);
          child.stderr?.on("data", onStderr);
          child.once("error", onError);
          child.once("exit", onExit);

          return {
            child,
            exited,
            completion,
            cleanupListeners: () => {
              child.stdout?.off("data", onStdout);
              child.stderr?.off("data", onStderr);
              child.off("error", onError);
              child.off("exit", onExit);
            },
          };
        }),
        (process) => terminateGatewayProcess(process, input.terminationGraceMs ?? 5_000),
      );

      const completion = Deferred.await(process.completion);
      return yield* input.timeoutMs === undefined
        ? completion
        : completion.pipe(
            Effect.timeoutOrElse({
              duration: input.timeoutMs,
              orElse: () => Effect.fail(new GatewayProcessError(`${input.label} timed out.`)),
            }),
          );
    }),
  );
}
