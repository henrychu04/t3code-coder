import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  collectUint8StreamText,
  decodeUtf8,
  type CollectedUint8StreamText,
} from "./stream/collectUint8StreamText.ts";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly truncatedMarker?: string | undefined;
  /**
   * On timeout, return a synthetic timedOut result.
   * Partial stdout/stderr are not preserved.
   */
  readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
  readonly onStdoutLine?: ((line: string) => Effect.Effect<void, never>) | undefined;
  readonly onStderrLine?: ((line: string) => Effect.Effect<void, never>) | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: ChildProcessSpawner.ExitCode | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
}

const ProcessInvocationFields = {
  command: Schema.String,
  argumentCount: Schema.Number,
  cwd: Schema.optional(Schema.String),
  spawnCwd: Schema.optional(Schema.String),
};

const formatProcessInvocation = (input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
}): string => {
  const executionCwd = input.spawnCwd ?? input.cwd;
  return executionCwd === undefined
    ? `'${input.command}'`
    : `'${input.command}' in '${executionCwd}'`;
};

export class ProcessSpawnError extends Schema.TaggedErrorClass<ProcessSpawnError>()(
  "ProcessSpawnError",
  {
    ...ProcessInvocationFields,
    resolvedCommand: Schema.optional(Schema.String),
    resolvedArgumentCount: Schema.optional(Schema.Number),
    shell: Schema.optional(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessStdinError extends Schema.TaggedErrorClass<ProcessStdinError>()(
  "ProcessStdinError",
  {
    ...ProcessInvocationFields,
    stdinBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write stdin for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessOutputLimitError extends Schema.TaggedErrorClass<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} ${this.stream} produced ${this.observedBytes} bytes, exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ProcessReadError extends Schema.TaggedErrorClass<ProcessReadError>()(
  "ProcessReadError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.stream} for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessTimeoutError extends Schema.TaggedErrorClass<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    ...ProcessInvocationFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} timed out after ${this.timeoutMs}ms`;
  }
}

export const ProcessRunError = Schema.Union([
  ProcessSpawnError,
  ProcessStdinError,
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessTimeoutError,
]);
export type ProcessRunError = typeof ProcessRunError.Type;

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
  }
>()("t3/processRunner") {}

const DEFAULT_TIMEOUT = "60 seconds";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export const isWindowsCommandNotFound = Effect.fn("processRunner.isWindowsCommandNotFound")(
  function* (code: number | null, stderr: string) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return false;
    if (code === 9009) return true;
    return hasWindowsCommandNotFoundMessage(stderr);
  },
);

const collectText = Effect.fn("processRunner.collectText")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
  readonly onLine?: ((line: string) => Effect.Effect<void, never>) | undefined;
}) {
  const stream = input.stream.pipe(
    Stream.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: input.streamName,
          cause,
        }),
    ),
  );

  if (input.onLine === undefined && input.outputMode === "truncate") {
    return yield* collectUint8StreamText({
      stream,
      maxBytes: input.maxOutputBytes,
      truncatedMarker: input.truncatedMarker,
    });
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";
  const emitLines = Effect.fn("processRunner.emitLines")(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && input.onLine) yield* input.onLine(line);
      newlineIndex = lineBuffer.indexOf("\n");
    }
    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && input.onLine) yield* input.onLine(trailing);
    }
  });

  const collected = yield* stream.pipe(
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array<ArrayBufferLike>[];
        readonly bytes: number;
        readonly truncated: boolean;
      },
      Uint8Array<ArrayBufferLike>,
      ProcessOutputLimitError | ProcessReadError,
      never
    >(
      () => ({ chunks: [], bytes: 0, truncated: false }),
      (state, chunk) => Effect.gen(function* () {
        const remainingBytes = input.maxOutputBytes - state.bytes;
        if (chunk.byteLength > remainingBytes) {
          if (input.outputMode === "truncate") {
            const retained = chunk.subarray(0, Math.max(0, remainingBytes));
            if (retained.byteLength > 0) {
              state.chunks.push(retained);
              lineBuffer += decoder.decode(retained, { stream: true });
              yield* emitLines(false);
            }
            return {
              chunks: state.chunks,
              bytes: input.maxOutputBytes,
              truncated: true,
            };
          }
          return yield* Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              argumentCount: input.args.length,
              cwd: input.cwd,
              spawnCwd: input.spawnCwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
              observedBytes: state.bytes + chunk.byteLength,
            }),
          );
        }

        state.chunks.push(chunk);
        lineBuffer += decoder.decode(chunk, { stream: true });
        yield* emitLines(false);
        return {
          chunks: state.chunks,
          bytes: state.bytes + chunk.byteLength,
          truncated: state.truncated,
        };
      }),
    ),
  );
  lineBuffer += decoder.decode();
  yield* emitLines(true);
  const decoded = decodeUtf8(Buffer.concat(collected.chunks, collected.bytes));
  return {
    ...decoded,
    text: collected.truncated
      ? `${decoded.text}${input.truncatedMarker}`
      : decoded.text,
    bytes: collected.bytes,
    truncated: collected.truncated,
  } satisfies CollectedUint8StreamText;
});

function finalizeRunProcess<R>(
  effect: Effect.Effect<ProcessRunOutput, ProcessRunError, R | Scope.Scope>,
  input: ProcessRunInput,
): Effect.Effect<ProcessRunOutput, ProcessRunError, Exclude<R, Scope.Scope>> {
  const timeout = Duration.fromInputUnsafe(input.timeout ?? DEFAULT_TIMEOUT);
  const timeoutBehavior = input.timeoutBehavior ?? "error";

  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(result.value);
      }
      if (timeoutBehavior === "timedOutResult") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } satisfies ProcessRunOutput);
      }
      return Effect.fail(
        new ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          timeoutMs: Duration.toMillis(timeout),
        }),
      );
    }),
  );
}

const runProcessCore = Effect.fn("processRunner.runProcessCore")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: ProcessRunInput,
): Effect.fn.Return<ProcessRunOutput, ProcessRunError, Scope.Scope> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "error";
  const truncatedMarker = input.truncatedMarker ?? "";
  const extendEnv = input.env !== undefined;
  const spawnCommand = yield* resolveSpawnCommand(
    input.command,
    input.args,
    input.env === undefined ? {} : { env: input.env, extendEnv },
  );

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
        ...(input.env !== undefined
          ? {
              env: input.env,
              extendEnv,
            }
          : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            resolvedCommand: spawnCommand.command,
            resolvedArgumentCount: spawnCommand.args.length,
            shell: spawnCommand.shell,
            cause,
          }),
      ),
    );

  const stdin = input.stdin;
  const writeStdin =
    stdin === undefined
      ? Effect.void
      : Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessStdinError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                stdinBytes: Buffer.byteLength(stdin),
                cause,
              }),
          ),
        );

  const [stdout, stderr] = yield* Effect.all(
    [
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stdout",
        stream: child.stdout,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
        ...(input.onStdoutLine ? { onLine: input.onStdoutLine } : {}),
      }),
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stderr",
        stream: child.stderr,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
        ...(input.onStderrLine ? { onLine: input.onStderrLine } : {}),
      }),
      writeStdin,
    ],
    { concurrency: "unbounded" },
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: "exitCode",
          cause,
        }),
    ),
  );

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: exitCode,
    timedOut: false,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutInvalidUtf8: stdout.invalidUtf8,
    stderrInvalidUtf8: stderr.invalidUtf8,
  } satisfies ProcessRunOutput;
});

export const make = Effect.fn("ProcessRunner.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: ProcessRunner["Service"]["run"] = (input) =>
    finalizeRunProcess(runProcessCore(spawner, input), input);

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());
