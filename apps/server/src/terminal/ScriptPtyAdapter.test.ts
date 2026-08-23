import { spawn } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { buildScriptCommand, createScriptPtyProcess } from "./ScriptPtyAdapter.ts";

describe("ScriptPtyAdapter", () => {
  it("separates terminal sizing from the shell exec command", () => {
    expect(
      buildScriptCommand({
        shell: "/bin/bash",
        args: ["-l", "it's-safe"],
        cols: 120,
        rows: 40,
      }),
    ).toBe(`stty cols 120 rows 40; exec '/bin/bash' '-l' 'it'"'"'s-safe'`);
  });

  it("turns an asynchronous spawn error into one exit event", async () => {
    const child = spawn("t3-definitely-missing-script-command", [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process = createScriptPtyProcess(child);

    const firstExit = await new Promise<{ exitCode: number; signal: number | null }>((resolve) => {
      process.onExit(resolve);
    });
    const lateExit = await new Promise<{ exitCode: number; signal: number | null }>((resolve) => {
      process.onExit(resolve);
    });

    expect(firstExit).toEqual({ exitCode: 1, signal: null });
    expect(lateExit).toEqual(firstExit);
  });

  it("handles stdin errors when writing after the child exits", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pty = createScriptPtyProcess(child);
    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });

    expect(() => pty.write("late terminal input")).not.toThrow();
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
  });
});
