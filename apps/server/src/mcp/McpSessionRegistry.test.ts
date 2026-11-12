import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as CoderEnvironment from "../coderEnvironment.ts";
import * as T3ToolDispatch from "./bridge/T3ToolDispatch.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

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
        tools.bind({
          catalog: [],
          dispatch: (scope) => Effect.succeed(scope.thread.threadId),
          invoke: () => Effect.succeed(null),
        }),
      ),
    ),
  ).pipe(Layer.provide(T3ToolDispatch.layer)),
  NodeServices.layer,
  NodeCrypto.layer,
);

const harness = Effect.fn(function* (options: { readonly livenessWindowMs?: number } = {}) {
  const parent = yield* FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-registry-" }),
    ),
    Effect.provide(NodeServices.layer),
  );
  const registry = yield* McpSessionRegistry.__testing
    .make({ bridgeParent: parent, ...options })
    .pipe(Effect.provide(services));
  const issue = (threadId: ThreadId) =>
    registry.issue({ threadId, providerInstanceId: CODEX }).pipe(Effect.map((c) => c.config));
  return { registry, issue };
});

const call = (toolCommand: string) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.string(ChildProcess.make("/bin/sh", ["-c", `${toolCommand} any_tool '{}'`])),
    ),
    Effect.map((stdout): unknown => JSON.parse(stdout)),
    Effect.provide(NodeServices.layer),
    Effect.orDie,
  );

const exists = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.exists(path)),
    Effect.provide(NodeServices.layer),
    Effect.orDie,
  );

it.live("keeps one hashed bridge directory per thread across session rotation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, issue } = yield* harness();
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
      const { registry, issue } = yield* harness();
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

const tokenOf = (config: { readonly authorizationHeader: string }) =>
  config.authorizationHeader.replace(/^Bearer\s+/, "");

it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, issue } = yield* harness({ livenessWindowMs: 100 });
      const threadId = ThreadId.make("thread-idle");
      const token = tokenOf(yield* issue(threadId));
      const scope = yield* registry.resolve(token);
      assert.isDefined(scope);

      yield* TestClock.adjust("101 millis");
      assert.isUndefined(yield* registry.resolve(token));
      const otherThreadId = ThreadId.make("thread-active");
      const other = yield* issue(otherThreadId);
      yield* registry.touch(otherThreadId);
      assert.strictEqual((yield* registry.resolve(tokenOf(other)))?.thread.threadId, otherThreadId);
      assert.isUndefined(yield* registry.resolve("unknown-token"));
      assert.isUndefined(yield* registry.resolve(token));

      yield* registry.touch(threadId);
      assert.deepStrictEqual(yield* registry.resolve(token), scope);
      yield* TestClock.adjust("101 millis");
      assert.isUndefined(yield* registry.resolve(token));
    }),
  ),
);

// Coder: upstream's case (#34532) on the bridge harness.
it.effect("a backward wall clock step neither extends nor revives credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, issue } = yield* harness({ livenessWindowMs: 100 });
      const issueToken = (threadId: string) =>
        issue(ThreadId.make(threadId)).pipe(Effect.map(tokenOf));

      yield* TestClock.setTime(10_000);
      const extended = yield* issueToken("thread-extended");
      // setTime backwards moves wall time only; adjust moves both clocks.
      yield* TestClock.setTime(1_000);
      yield* TestClock.adjust(101);
      assert.isUndefined(yield* registry.resolve(extended));

      const revived = yield* issueToken("thread-revived");
      yield* TestClock.adjust(101);
      assert.isUndefined(yield* registry.resolve(revived));
      const active = yield* issueToken("thread-active");
      yield* TestClock.setTime(0);
      assert.isUndefined(yield* registry.resolve(revived));
      assert.strictEqual((yield* registry.resolve(active))?.thread.threadId, "thread-active");
    }),
  ),
);

it.effect.each(["provider-session", "thread", "all"] as const)(
  "never restores an expired token after %s revocation",
  (revocation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, issue } = yield* harness({ livenessWindowMs: 100 });
        const threadId = ThreadId.make("thread-revoked");
        const config = yield* issue(threadId);

        yield* TestClock.adjust("101 millis");
        yield* {
          "provider-session": registry.revokeProviderSession(config.providerSessionId),
          thread: registry.revokeThread(threadId),
          all: registry.revokeAll,
        }[revocation];
        yield* registry.touch(threadId);
        assert.isUndefined(yield* registry.resolve(tokenOf(config)));
      }),
    ),
);
