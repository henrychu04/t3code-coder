// @effect-diagnostics nodeBuiltinImport:off
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";

import type { CoderInvocation } from "./command.ts";

const MAX_INSTALL_ERROR_BYTES = 32 * 1024;

export function installCoderHelper(
  invocation: CoderInvocation,
  helperBundlePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_INSTALL_ERROR_BYTES) return;
      stderr += chunk.toString("utf8").slice(0, MAX_INSTALL_ERROR_BYTES - stderr.length);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Coder helper installation failed (code ${String(code)}, signal ${String(signal)}).${stderr.trim().length === 0 ? "" : ` ${stderr.trim()}`}`,
        ),
      );
    });
    const bundle = createReadStream(helperBundlePath);
    bundle.once("error", (cause) => {
      child.kill();
      reject(cause);
    });
    bundle.pipe(child.stdin);
  });
}
