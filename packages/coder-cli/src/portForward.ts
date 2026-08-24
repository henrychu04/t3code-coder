// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This is a foreground child-process adapter.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { CoderInvocation } from "./command.ts";

const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export interface CoderPortForwardExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly reason?: string;
}

export interface CoderPortForwardConnection {
  readonly closed: Promise<CoderPortForwardExit>;
  readonly close: () => void;
}

type SpawnCoderProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function connectCoderPortForward(
  invocation: CoderInvocation,
  options?: {
    readonly spawnProcess?: SpawnCoderProcess;
    readonly terminationGraceMs?: number;
  },
): Promise<CoderPortForwardConnection> {
  const child = (options?.spawnProcess ?? spawn)(invocation.executable, invocation.args, {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let closeRequested = false;
  let stderr = "";
  let settled = false;
  let resolveClosed: (exit: CoderPortForwardExit) => void = () => undefined;
  const closed = new Promise<CoderPortForwardExit>((resolve) => {
    resolveClosed = resolve;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length >= MAX_ERROR_BYTES) return;
    stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BYTES - stderr.length);
  });

  return new Promise((resolve, reject) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, cause?: Error): void => {
      const detail = stderr.trim();
      const reason = closeRequested
        ? undefined
        : cause?.message ??
          `Coder port forward exited with code ${String(code)} (${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`;
      resolveClosed({
        code,
        signal,
        expected: closeRequested,
        ...(reason === undefined ? {} : { reason }),
      });
    };
    child.once("error", (cause) => {
      finish(null, null, cause);
      if (!settled) {
        settled = true;
        reject(cause);
      }
    });
    child.once("exit", (code, signal) => finish(code, signal));
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve({
        closed,
        close: () => {
          if (closeRequested) return;
          closeRequested = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          const forceKillSignal = AbortSignal.timeout(
            options?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
          );
          forceKillSignal.addEventListener("abort", () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          });
        },
      });
    });
  });
}
