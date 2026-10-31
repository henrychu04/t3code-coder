// @effect-diagnostics nodeBuiltinImport:off -- This module adapts Node child processes to Effect.
import type { ChildProcess } from "node:child_process";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class CoderProcessExitUnconfirmedError extends Error {
  readonly _tag = "CoderProcessExitUnconfirmedError";

  constructor() {
    super("Coder process did not exit after SIGKILL; shutdown was not confirmed.");
    this.name = "CoderProcessExitUnconfirmedError";
  }
}

/**
 * Stops a foreground child process and waits for its exit, one grace period per step: the
 * optional `requestExit`, then SIGTERM, then SIGKILL. It dies if no exit follows SIGKILL, so a
 * stuck process is reported rather than awaited forever.
 *
 * On Windows Node implements both signals with TerminateProcess, so SIGTERM already force-stops
 * `coder.exe` without closing its SSH session; `requestExit` is the only clean stop there.
 */
export const terminateChildProcess = <A>(input: {
  readonly child: Pick<ChildProcess, "kill" | "exitCode" | "signalCode">;
  readonly exit: Deferred.Deferred<A>;
  readonly graceMs: number;
  readonly requestExit?: () => void;
}): Effect.Effect<void> => {
  const { child, exit, graceMs } = input;
  const exited = () => Deferred.isDoneUnsafe(exit);
  const awaitExit = Deferred.await(exit).pipe(
    Effect.timeoutOption(graceMs),
    Effect.map(Option.isSome),
  );
  // A failed signal is not an exit; every step still waits for the exit event.
  const signal = (name: NodeJS.Signals) => {
    if (exited() || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(name);
    } catch {
      /* The next step escalates. */
    }
  };
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (exited()) return;
      if (input.requestExit !== undefined) {
        try {
          input.requestExit();
        } catch {
          /* Fall back to signals. */
        }
        if (yield* awaitExit) return;
      }
      signal("SIGTERM");
      if (yield* awaitExit) return;
      signal("SIGKILL");
      if (yield* awaitExit) return;
      return yield* Effect.die(new CoderProcessExitUnconfirmedError());
    }),
  );
};
