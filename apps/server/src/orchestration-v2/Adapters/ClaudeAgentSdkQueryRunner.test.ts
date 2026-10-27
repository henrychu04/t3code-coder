// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
// Coder: the runner queries Claude through the CLI transport's SDK-typed shim, so the test
// stubs the shim's query rather than the Agent SDK's.
import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
  spawnClaudeProcessGroup,
} from "./ClaudeAdapterV2.ts";

vi.mock("../../provider/Drivers/ClaudeAgentSdk.ts", { spy: true });

// Coder: upstream's fork tests copy the transcript through the Agent SDK; the CLI transport
// forks natively on the fork's first query (`ClaudeAdapterV2.forkThread`), so they are not carried.
const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The leftover child holds a FIFO open; its death produces EOF without polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );

  // The CLI keeps running its turn after its pipes close, so a server that
  // crashed would leave it working next to the session it resumes.
  it.effect("stops the CLI when the server that started it goes away", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"));
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      const child = spawnClaudeProcessGroup({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        signal: new AbortController().signal,
      }) as NodeChildProcess.ChildProcess;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            signalProcessGroup(child.pid ?? 0, "SIGKILL");
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const turnStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const turnStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      yield* Effect.promise(() => turnStarted);

      // A dying server's descriptors close; the kernel would do this for it.
      for (const pipe of child.stdio) pipe?.destroy();
      yield* Effect.promise(() => turnStopped);
    }),
  );
});
