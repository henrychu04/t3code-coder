// @effect-diagnostics nodeBuiltinImport:off -- This is the Linux script(1) PTY boundary.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PtyAdapter from "./PtyAdapter.ts";

const quoteShellWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildScriptCommand = (input: {
  readonly shell: string;
  readonly args?: readonly string[];
  readonly cols: number;
  readonly rows: number;
}): string =>
  [
    `stty cols ${Math.max(1, input.cols)} rows ${Math.max(1, input.rows)};`,
    "exec",
    quoteShellWord(input.shell),
    ...(input.args ?? []).map(quoteShellWord),
  ].join(" ");

class ScriptPtyProcess implements PtyAdapter.PtyProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private didExit = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      for (const listener of this.dataListeners) listener(data);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      for (const listener of this.dataListeners) listener(data);
    });
    child.once("exit", (exitCode) => {
      this.didExit = true;
      const event = { exitCode: exitCode ?? 1, signal: null };
      for (const listener of this.exitListeners) listener(event);
    });
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  write(data: string): void {
    this.child.stdin.write(data);
  }

  resize(_cols: number, _rows: number): void {
    // util-linux script(1) owns the PTY. The initial dimensions are applied
    // before the shell starts; resize is intentionally best-effort for this
    // dependency-free Coder transport.
  }

  kill(signal?: string): void {
    this.child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.didExit) {
      queueMicrotask(() => callback({ exitCode: this.child.exitCode ?? 1, signal: null }));
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

export const make = Effect.succeed(
  PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.try({
        try: () => {
          const command = buildScriptCommand(input);
          const child = spawn("script", ["-qefc", command, "/dev/null"], {
            cwd: input.cwd,
            env: { ...input.env, TERM: input.env.TERM ?? "xterm-256color" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          return new ScriptPtyProcess(child);
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "util-linux-script",
            shell: input.shell,
            cause,
          }),
      }),
  }),
);

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make);
