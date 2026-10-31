// Coder: the workspace health card's resource usage, read here with `coder stat` so the laptop
// starts no `coder ssh` for it.
import * as NodeOS from "node:os";

import { CoderWorkspaceResourceUsage, CoderWorkspaceResourceUsageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "./processRunner.ts";

const STAT_TIMEOUT = "15 seconds";
/** One `coder stat` JSON object is a few hundred bytes. */
const MAX_STAT_OUTPUT_BYTES = 64 * 1024;

const decodeUsage = Schema.decodeUnknownEffect(CoderWorkspaceResourceUsage);

/**
 * The Coder agent's own CLI. An SSH session's shell has it on PATH, but the helper's environment
 * may not; the agent always points `GIT_SSH_COMMAND` at it (`<agent>/coder gitssh --`).
 */
function coderExecutable(): string {
  const agent = process.env.GIT_SSH_COMMAND?.match(/^(\/\S*\/coder) gitssh\b/)?.[1];
  return agent ?? "coder";
}

export const readCoderWorkspaceResourceUsage = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const stat = (args: ReadonlyArray<string>) =>
    runner
      .run({
        command: coderExecutable(),
        args: ["--no-version-warning", "stat", ...args, "--output=json"],
        timeout: STAT_TIMEOUT,
        maxOutputBytes: MAX_STAT_OUTPUT_BYTES,
      })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.try(() => JSON.parse(output.stdout) as unknown)
            : Effect.fail(new Error(`coder stat exited with code ${String(output.code)}.`)),
        ),
      );
  const [cpu, memory, disk] = yield* Effect.all(
    [stat(["cpu"]), stat(["mem"]), stat(["disk", "--path", NodeOS.homedir()])],
    { concurrency: "unbounded" },
  );
  return yield* decodeUsage({ cpu, memory, disk });
}).pipe(
  Effect.mapError(
    () =>
      new CoderWorkspaceResourceUsageError({
        message: "Could not read the workspace's resource usage with `coder stat`.",
      }),
  ),
);
