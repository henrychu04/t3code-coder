// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";
  readonly options: CodexSessionRuntimeOptions;

  readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({ threadId: this.options.threadId, turnId: asTurnId("turn-1") }),
  );
  readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(_turnId?: TurnId) {
    return Effect.void;
  }

  readThread = Effect.succeed({
    threadId: "provider-thread-1",
    turns: [],
  } satisfies CodexThreadSnapshot);

  rollbackThread(_numTurns: number) {
    return this.readThread;
  }

  uploadFeedback(_reason?: string) {
    return Effect.succeed({ threadId: "provider-thread-1" });
  }

  respondToRequest(_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision) {
    return Effect.void;
  }

  respondToUserInput(_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers) {
    return Effect.void;
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];
  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );
      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }
      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const runtimeFactory = makeRuntimeFactory();
const adapterLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(
      decodeCodexSettings({
        binaryPath: "/workspace/bin/codex",
        homePath: "/workspace/.codex-personal",
        launchArgs: "--strict-config --enable collaboration_modes",
      }),
      {
        instanceId: ProviderInstanceId.make("codex_personal"),
        environment: { T3_TEST_ENV: "1" },
        makeRuntime: runtimeFactory.factory,
      },
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer)),
);

adapterLayer("CodexAdapter Coder integration", (it) => {
  it.effect("rejects a non-Codex provider before constructing a runtime", () =>
    Effect.gen(function* () {
      runtimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("validation-thread"),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      NodeAssert.equal(runtimeFactory.factory.mock.calls.length, 0);
    }),
  );

  it.effect("binds workspace settings and custom-instance model options", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("settings-thread"),
        cwd: "/workspace/project",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("codex_personal"),
          "gpt-5.6-luna",
          [{ id: "serviceTier", value: "priority" }],
        ),
        runtimeMode: "approval-required",
      });

      NodeAssert.deepStrictEqual(runtimeFactory.lastRuntime?.options, {
        binaryPath: "/workspace/bin/codex",
        cwd: "/workspace/project",
        environment: { T3_TEST_ENV: "1" },
        homePath: "/workspace/.codex-personal",
        launchArgs: "--strict-config --enable collaboration_modes",
        model: "gpt-5.6-luna",
        providerInstanceId: ProviderInstanceId.make("codex_personal"),
        runtimeMode: "approval-required",
        serviceTier: "priority",
        threadId: asThreadId("settings-thread"),
      });
    }),
  );

  it.effect("maps turn options only for the adapter's bound instance", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("turn-options-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "approval-required",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.sendTurn({
        threadId,
        input: "test luna",
        interactionMode: "plan",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("codex_personal"),
          "gpt-5.6-luna",
          [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "flex" },
          ],
        ),
      });
      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls.at(-1)?.[0], {
        input: "test luna",
        interactionMode: "plan",
        model: "gpt-5.6-luna",
        effort: "high",
        serviceTier: "flex",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "keep this session",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
        ),
      });
      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls.at(-1)?.[0], {
        input: "keep this session",
      });
    }),
  );

  it.effect("returns a typed error for an unknown adapter session", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({ threadId: asThreadId("missing-thread"), input: "hello" })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "missing-thread");
    }),
  );

  it.effect("keeps consuming events after the startSession request completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("event-thread");
      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startFiber);

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("event-after-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId,
        turnId: asTurnId("turn-1"),
        itemId: asItemId("message-1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "event-thread",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "message-1", text: "done" },
        },
      });

      const event = yield* Fiber.join(eventFiber).pipe(Effect.timeout("10 seconds"));
      NodeAssert.equal(event._tag, "Some");
      if (event._tag === "Some") {
        NodeAssert.equal(event.value.type, "item.completed");
      }
    }).pipe(TestClock.withLive),
  );
});

const scopedRuntimeFactory = makeRuntimeFactory();
const scopedLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: scopedRuntimeFactory.factory,
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer)),
);

scopedLayer("CodexAdapter lifecycle", (it) => {
  it.effect("closes the runtime and its owned scope on stop", () =>
    Effect.gen(function* () {
      scopedRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("stop-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "approval-required",
      });
      const runtime = scopedRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(threadId);

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedRuntimeFactory.releasedThreadIds, [threadId]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );
});

const failingRuntimeFactory = makeRuntimeFactory({ failConstruction: true });
const failingLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: failingRuntimeFactory.factory,
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer)),
);

failingLayer("CodexAdapter startup failure", (it) => {
  it.effect("closes the runtime scope when construction fails", () =>
    Effect.gen(function* () {
      failingRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("failed-thread");
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(failingRuntimeFactory.releasedThreadIds, [threadId]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );
});
