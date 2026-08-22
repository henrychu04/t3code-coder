// @effect-diagnostics nodeBuiltinImport:off
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import * as NodeTimers from "node:timers";

import type { CoderInvocation } from "./command.ts";

const MAX_INSTALL_ERROR_BYTES = 32 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 2 * 60_000;

export function installCoderHelper(
  invocation: CoderInvocation,
  helperBundlePath: string,
  options?: { readonly timeoutMs?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const bundle = createReadStream(helperBundlePath);
    let stderr = "";
    let stdinError: Error | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
      bundle.destroy();
      resolve();
    };
    const rejectOnce = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
      bundle.destroy();
      reject(cause);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_INSTALL_ERROR_BYTES) return;
      stderr += chunk.toString("utf8").slice(0, MAX_INSTALL_ERROR_BYTES - stderr.length);
    });
    child.stdin.on("error", (cause: Error) => {
      // The process exit below is authoritative and includes Coder's stderr.
      // Retaining this error keeps an early EPIPE from becoming uncaught.
      stdinError = cause;
    });
    child.once("error", rejectOnce);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveOnce();
        return;
      }
      const detail = stderr.trim() || stdinError?.message.trim() || "";
      rejectOnce(
        new Error(
          `Coder helper installation failed (code ${String(code)}, signal ${String(signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
        ),
      );
    });
    bundle.once("error", (cause) => {
      child.kill();
      rejectOnce(cause);
    });
    timeout = NodeTimers.setTimeout(() => {
      child.kill();
      rejectOnce(new Error("Timed out while installing the Coder workspace helper."));
    }, options?.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
    bundle.pipe(child.stdin);
  });
}
