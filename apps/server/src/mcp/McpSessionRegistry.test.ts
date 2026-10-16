import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as CoderEnvironment from "../coderEnvironment.ts";
import * as T3ToolDispatch from "./bridge/T3ToolDispatch.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const exec = promisify(execFile);
const THREAD_ID = ThreadId.make("thread/with spaces 'and' quotes");
const OTHER_THREAD_ID = ThreadId.make("thread-other");
const CODEX = ProviderInstanceId.make("codex");

const services = Layer.mergeAll(
  Layer.succeed(
    CoderEnvironment.CoderEnvironment,
    CoderEnvironment.CoderEnvironment.of({
      descriptor: {
        environmentId: EnvironmentId.make("environment-mcp-session-registry"),
      } as CoderEnvironment.CoderEnvironment["Service"]["descriptor"],
    }),
  ),
  Layer.effect(
    T3ToolDispatch.T3ToolDispatch,
    T3ToolDispatch.T3ToolDispatch.pipe(
      Effect.tap((tools) =>
        tools.bind({ catalog: [], dispatch: (scope) => Effect.succeed(scope.thread.threadId) }),
      ),
    ),
  ).pipe(Layer.provide(T3ToolDispatch.layer)),
  NodeServices.layer,
);

const harness = Effect.gen(function* () {
  const parent = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-mcp-registry-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const registry = yield* McpSessionRegistry.__testing
    .make({ bridgeParent: parent })
    .pipe(Effect.provide(services));
  const issue = (threadId: ThreadId) =>
    registry.issue({ threadId, providerInstanceId: CODEX }).pipe(Effect.map((c) => c.config));
  return { registry, issue };
});

const call = (toolCommand: string) =>
  Effect.promise(() =>
    exec("/bin/sh", ["-c", `${toolCommand} any_tool '{}'`]).then((result) =>
      JSON.parse(result.stdout),
    ),
  );

const exists = (path: string) =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );

it.live("keeps one hashed bridge directory per thread across session rotation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, issue } = yield* harness;
      const first = yield* issue(THREAD_ID);
      assert.match(first.endpoint, /\/t3-tools-[0-9a-f]{20}$/u);
      assert.strictEqual(yield* call(first.toolCommand!), THREAD_ID);

      yield* registry.revokeThread(THREAD_ID);
      assert.isFalse(yield* exists(first.endpoint));
      const second = yield* issue(THREAD_ID);
      assert.notStrictEqual(second.providerSessionId, first.providerSessionId);
      assert.strictEqual(second.endpoint, first.endpoint);
      assert.strictEqual(second.toolCommand, first.toolCommand);

      // A late revocation of the old session must not remove the thread's new bridge.
      yield* registry.revokeProviderSession(first.providerSessionId);
      assert.strictEqual(yield* call(second.toolCommand!), THREAD_ID);

      const other = yield* issue(OTHER_THREAD_ID);
      assert.notStrictEqual(other.endpoint, second.endpoint);
      assert.strictEqual(yield* call(other.toolCommand!), OTHER_THREAD_ID);
    }),
  ),
);

it.live("reissues a working bridge while an old session is still being revoked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, issue } = yield* harness;
      const first = yield* issue(THREAD_ID);
      // A session release revokes outside the manager's per-thread lock. The race is timing-bound,
      // so this checks the outcome rather than forcing the overlap.
      const release = yield* registry
        .revokeProviderSession(first.providerSessionId)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* registry.revokeThread(THREAD_ID);
      const second = yield* issue(THREAD_ID);
      yield* Fiber.join(release);
      assert.strictEqual(second.endpoint, first.endpoint);
      assert.strictEqual(yield* call(second.toolCommand!), THREAD_ID);
    }),
  ),
);
