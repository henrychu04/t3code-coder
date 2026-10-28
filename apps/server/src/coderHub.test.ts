import { assert, it } from "@effect/vitest";
import {
  CODER_HUB_INVOKE_METHOD,
  type CoderHubCallOutcome,
  type CoderHubRequest,
} from "@t3tools/coder-cli/rpc";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CoderHub from "./coderHub.ts";
import { ServerEnvironmentIdentity } from "./coderEnvironment.ts";
import { FileBridgeToolFailure } from "./mcp/bridge/FileBridge.ts";
import * as T3ToolDispatch from "./mcp/bridge/T3ToolDispatch.ts";
import type * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as ServerSettings from "./serverSettings.ts";

const target = EnvironmentId.make("environment:box");
const limits = { runtimeMode: "auto-accept-edits", interactionMode: "default" } as const;

/** Subscribes as the gateway does, keeping the subscription open, and hands out its requests. */
const subscribe = (hub: CoderHub.CoderHub["Service"]) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<CoderHubRequest>();
    yield* hub.outbox.pipe(
      Stream.runForEach((request) => Queue.offer(received, request)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    return received;
  });

it.effect("fails a call at once when no gateway is subscribed", () =>
  Effect.gen(function* () {
    const hub = yield* CoderHub.CoderHub;
    const failure = yield* hub
      .call({ environmentId: target, tool: "t3_thread_read", arguments: {}, limits })
      .pipe(Effect.flip);
    assert.strictEqual(failure, CoderHub.noGateway);
  }).pipe(Effect.provide(CoderHub.layer)),
);

it.effect("sends a call through the outbox and returns the gateway's answer", () =>
  Effect.gen(function* () {
    const hub = yield* CoderHub.CoderHub;
    const gateway = yield* subscribe(hub);
    const call = yield* hub
      .call({ environmentId: target, tool: "t3_thread_read", arguments: { a: 1 }, limits })
      .pipe(Effect.forkChild);
    const sent = yield* Queue.take(gateway);
    const links = yield* hub.listLinks.pipe(Effect.forkChild);
    const listed = yield* Queue.take(gateway);
    assert.deepStrictEqual(sent, {
      _tag: "Call",
      id: sent.id,
      environmentId: target,
      tool: "t3_thread_read",
      arguments: { a: 1 },
      limits,
    });
    assert.strictEqual(listed._tag, "ListLinks");
    const outcome: CoderHubCallOutcome = { _tag: "Success", value: { ok: true } };
    yield* hub.reply({ _tag: "Call", id: sent.id, outcome });
    yield* hub.reply({
      _tag: "ListLinks",
      id: listed.id,
      links: [{ environmentId: target, label: "box", access: "read-only", connected: true }],
    });
    assert.deepStrictEqual(yield* Fiber.join(call), outcome);
    assert.deepStrictEqual(yield* Fiber.join(links), [
      { environmentId: target, label: "box", access: "read-only", connected: true },
    ]);
  }).pipe(Effect.provide(CoderHub.layer)),
);

it.effect("fails what the previous subscriber left unanswered when the gateway resubscribes", () =>
  Effect.gen(function* () {
    const hub = yield* CoderHub.CoderHub;
    const first = yield* subscribe(hub);
    const call = yield* hub
      .call({ environmentId: target, tool: "t3_thread_read", arguments: {}, limits })
      .pipe(Effect.flip, Effect.forkChild);
    assert.strictEqual((yield* Queue.take(first))._tag, "Call");
    yield* subscribe(hub);
    assert.strictEqual(yield* Fiber.join(call), CoderHub.noGateway);
  }).pipe(Effect.provide(CoderHub.layer)),
);

it.effect("gives up on an unanswered call after the timeout", () =>
  Effect.gen(function* () {
    const hub = yield* CoderHub.CoderHub;
    const gateway = yield* subscribe(hub);
    const call = yield* hub
      .call({ environmentId: target, tool: "t3_thread_read", arguments: {}, limits })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Queue.take(gateway);
    yield* TestClock.adjust(CoderHub.CODER_HUB_CALL_TIMEOUT);
    const failure = yield* Fiber.join(call);
    assert.strictEqual(failure.code, "orchestration_error");
    assert.notStrictEqual(failure, CoderHub.noGateway);
  }).pipe(Effect.provide(CoderHub.layer)),
);

const here = EnvironmentId.make("environment:here");

/** The hub handlers over a fake tool binding that records each call's scope. */
const invokeWith = (options: {
  readonly linkedEnvironmentsEnabled: boolean;
  readonly bound: boolean;
  readonly answer?: Effect.Effect<unknown, FileBridgeToolFailure>;
}) =>
  Effect.gen(function* () {
    const scopes: Array<McpInvocationContext.McpInvocationScope> = [];
    const tools = yield* T3ToolDispatch.T3ToolDispatch;
    if (options.bound) {
      yield* tools.bind({
        catalog: [],
        dispatch: () => Effect.die("unused dispatch"),
        invoke: (scope, request) => {
          scopes.push(scope);
          return options.answer ?? Effect.succeed({ tool: request.tool, params: request.params });
        },
      });
    }
    const handlers = yield* CoderHub.makeHandlers;
    const outcome = yield* (
      handlers[CODER_HUB_INVOKE_METHOD] as (payload: unknown) => Effect.Effect<CoderHubCallOutcome>
    )({
      link: { id: "laptop-to-box", label: "laptop", access: "approval-required" },
      tool: "t3_thread_read",
      arguments: { threadId: "thread-1" },
      limits,
    });
    return { outcome, scopes };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CoderHub.layer,
        T3ToolDispatch.layer,
        ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linkedEnvironmentsEnabled }),
        Layer.succeed(
          ServerEnvironmentIdentity,
          ServerEnvironmentIdentity.of({ getEnvironmentId: Effect.succeed(here) }),
        ),
      ),
    ),
  );

it.effect("runs an invoked tool as the link's caller, capped by the calling agent's modes", () =>
  Effect.gen(function* () {
    const { outcome, scopes } = yield* invokeWith({ linkedEnvironmentsEnabled: true, bound: true });
    assert.deepStrictEqual(outcome, {
      _tag: "Success",
      value: { tool: "t3_thread_read", params: { threadId: "thread-1" } },
    });
    const [scope] = scopes;
    assert.strictEqual(scope?.environmentId, here);
    assert.strictEqual(scope?.thread, undefined);
    // As upstream's `/mcp` scopes a linked environment's OAuth session.
    assert.deepStrictEqual(scope?.client, {
      sessionId: "coder-link:laptop-to-box",
      label: "laptop",
      access: "approval-required",
      linked: true,
      narrowedTo: limits,
    });
    assert.deepStrictEqual(
      [...(scope?.capabilities ?? [])],
      ["orchestration", "worktree", "pull-requests"],
    );
  }),
);

it.effect("refuses an invoked tool while Linked environments is off here", () =>
  Effect.gen(function* () {
    const { outcome, scopes } = yield* invokeWith({
      linkedEnvironmentsEnabled: false,
      bound: true,
    });
    assert.strictEqual(outcome._tag, "Failure");
    if (outcome._tag === "Failure") assert.strictEqual(outcome.failure.code, "orchestration_error");
    assert.strictEqual(scopes.length, 0);
  }),
);

it.effect("asks the caller to retry while the tools are still starting", () =>
  Effect.gen(function* () {
    const { outcome } = yield* invokeWith({ linkedEnvironmentsEnabled: true, bound: false });
    assert.strictEqual(outcome._tag, "Failure");
    if (outcome._tag === "Failure") {
      assert.strictEqual(outcome.failure.code, "orchestration_error");
    }
  }),
);

it.effect("passes the tool's own failure back, and names any other one", () =>
  Effect.gen(function* () {
    const declared = new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "No such thread.",
    });
    const passed = yield* invokeWith({
      linkedEnvironmentsEnabled: true,
      bound: true,
      answer: Effect.fail(
        new FileBridgeToolFailure({
          value: { _tag: "OrchestratorMcpFailure", code: declared.code, message: declared.message },
        }),
      ),
    });
    assert.strictEqual(passed.outcome._tag, "Failure");
    if (passed.outcome._tag === "Failure") {
      assert.strictEqual(passed.outcome.failure.code, "thread_not_found");
      assert.strictEqual(passed.outcome.failure.message, "No such thread.");
    }
    const other = yield* invokeWith({
      linkedEnvironmentsEnabled: true,
      bound: true,
      answer: Effect.fail(
        new FileBridgeToolFailure({ value: { error: "UnknownTool", message: "Unknown T3 tool." } }),
      ),
    });
    assert.strictEqual(other.outcome._tag, "Failure");
    if (other.outcome._tag === "Failure") {
      assert.strictEqual(other.outcome.failure.code, "orchestration_error");
      assert.strictEqual(other.outcome.failure.message, "Unknown T3 tool.");
    }
  }),
);
