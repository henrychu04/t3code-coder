import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoderHelperConnection, CoderHelperExit } from "@t3tools/coder-cli/helperConnection";
import {
  CODER_HUB_INVOKE_METHOD,
  CODER_HUB_OUTBOX_METHOD,
  CODER_HUB_REPLY_METHOD,
} from "@t3tools/coder-cli/rpc";
import type { CoderProfileConfig, CoderWorkspaceLinkProfile } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeCoderHub } from "./hub.ts";

interface SentRequest {
  readonly _tag: string;
  readonly id?: string;
  readonly requestId?: string;
  readonly tag?: string;
  readonly payload?: Record<string, unknown>;
}

interface FakeHelper {
  readonly connection: CoderHelperConnection;
  readonly sent: Array<SentRequest>;
  readonly emit: (message: unknown) => void;
  readonly exit: () => void;
  /** The id of the outbox stream the hub opened. */
  readonly outboxId: () => string;
  /** Pushes hub requests down the outbox stream. */
  readonly ask: (...values: Array<unknown>) => void;
  readonly requests: (tag: string) => Array<SentRequest>;
}

function fakeHelper(environmentId: string, protocolVersion = 3): FakeHelper {
  const sent: Array<SentRequest> = [];
  const listeners = new Set<(message: unknown) => void>();
  const closed = Effect.runSync(Deferred.make<CoderHelperExit>());
  const requests = (tag: string) => sent.filter((message) => message.tag === tag);
  const outboxId = () => {
    const outbox = requests(CODER_HUB_OUTBOX_METHOD)[0];
    assert.ok(outbox?.id, "the hub opens the outbox");
    return outbox.id;
  };
  const emit = (message: unknown) => {
    for (const listener of [...listeners]) listener(message);
  };
  return {
    connection: {
      info: {
        protocolVersion,
        platform: "linux",
        architecture: "x64",
        environment: { environmentId } as never,
      },
      closed: Deferred.await(closed),
      sendRpc: (message) => Effect.sync(() => void sent.push(message as SentRequest)),
      needsDrain: () => false,
      drained: Effect.void,
      onRpcMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: Effect.void,
    },
    sent,
    emit,
    exit: () => Effect.runSync(Deferred.succeed(closed, { code: 0, signal: null, expected: true })),
    outboxId,
    ask: (...values) => emit({ _tag: "Chunk", requestId: outboxId(), values }),
    requests,
  };
}

const config = (links: ReadonlyArray<CoderWorkspaceLinkProfile>): CoderProfileConfig => ({
  version: 1,
  deployments: [{ id: "lab", name: "Lab", url: "https://coder.example" }],
  workspaces: [
    { id: "api", name: "API", deploymentId: "lab", workspace: "dev/api" },
    { id: "web", name: "Web", deploymentId: "lab", workspace: "dev/web" },
  ],
  workspaceLinks: links,
});

const API_TO_WEB: CoderWorkspaceLinkProfile = {
  id: "api-to-web",
  from: "api",
  to: "web",
  access: "approval-required",
};

const call = (id: string, environmentId: string) => ({
  _tag: "Call",
  id,
  environmentId,
  tool: "t3_thread_read",
  arguments: { threadId: "thread-1" },
  limits: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
});

async function eventually(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

const replies = (helper: FakeHelper) =>
  helper.requests(CODER_HUB_REPLY_METHOD).map((message) => message.payload);

function setup(links: ReadonlyArray<CoderWorkspaceLinkProfile> = [API_TO_WEB]) {
  let current = config(links);
  const hub = makeCoderHub({ config: () => current });
  const api = fakeHelper("env-api");
  const web = fakeHelper("env-web");
  const detachApi = hub.attach("api", api.connection);
  const detachWeb = hub.attach("web", web.connection);
  return {
    hub,
    api,
    web,
    detachApi,
    detachWeb,
    setConfig: (next: ReadonlyArray<CoderWorkspaceLinkProfile>) => (current = config(next)),
  };
}

test("routes a linked call to the target workspace as that link's caller", async () => {
  const { api, web } = setup();
  api.ask(call("call-1", "env-web"));

  await eventually(() => assert.equal(web.requests(CODER_HUB_INVOKE_METHOD).length, 1));
  const invoke = web.requests(CODER_HUB_INVOKE_METHOD)[0]!;
  assert.deepEqual(invoke.payload, {
    link: { id: "api-to-web", label: "API", access: "approval-required" },
    tool: "t3_thread_read",
    arguments: { threadId: "thread-1" },
    limits: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
  });
  assert.ok(
    api.sent.some((message) => message._tag === "Ack" && message.requestId === api.outboxId()),
  );

  web.emit({
    _tag: "Exit",
    requestId: invoke.id,
    exit: { _tag: "Success", value: { _tag: "Success", value: { status: "idle" } } },
  });
  await eventually(() =>
    assert.deepEqual(replies(api), [
      { _tag: "Call", id: "call-1", outcome: { _tag: "Success", value: { status: "idle" } } },
    ]),
  );
});

test("refuses a call without a link rule, and one whose target is disconnected", async () => {
  const { api, web, detachWeb, setConfig } = setup([]);
  api.ask(call("no-rule", "env-web"));
  api.ask(call("unknown", "env-elsewhere"));
  await eventually(() => assert.equal(replies(api).length, 2));
  for (const reply of replies(api)) {
    assert.equal((reply?.outcome as { _tag: string })._tag, "Failure");
    assert.equal(
      ((reply?.outcome as { failure: { code: string } }).failure as { code: string }).code,
      "capability_denied",
    );
  }
  assert.equal(web.requests(CODER_HUB_INVOKE_METHOD).length, 0);

  setConfig([API_TO_WEB]);
  detachWeb();
  api.ask(call("gone", "env-web"));
  await eventually(() => assert.equal(replies(api).length, 3));
  const failure = (replies(api)[2]?.outcome as { failure: { code: string; message: string } })
    .failure;
  assert.equal(failure.code, "orchestration_error");
  assert.equal(failure.message, "Workspace Web is not connected.");
});

test("fails a call whose target exits before answering", async () => {
  const { api, web } = setup();
  api.ask(call("call-1", "env-web"));
  await eventually(() => assert.equal(web.requests(CODER_HUB_INVOKE_METHOD).length, 1));
  web.exit();
  await eventually(() => assert.equal(replies(api).length, 1));
  const outcome = replies(api)[0]?.outcome as { _tag: string; failure: { code: string } };
  assert.equal(outcome._tag, "Failure");
  assert.equal(outcome.failure.code, "orchestration_error");
});

test("interrupts a requester's calls when it goes away and sends it nothing", async () => {
  const { api, web, detachApi } = setup();
  api.ask(call("call-1", "env-web"));
  await eventually(() => assert.equal(web.requests(CODER_HUB_INVOKE_METHOD).length, 1));
  const invoke = web.requests(CODER_HUB_INVOKE_METHOD)[0]!;
  detachApi();
  assert.ok(
    web.sent.some((message) => message._tag === "Interrupt" && message.requestId === invoke.id),
  );
  web.emit({
    _tag: "Exit",
    requestId: invoke.id,
    exit: { _tag: "Success", value: { _tag: "Success", value: {} } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies(api), []);
});

test("lists this workspace's links to workspaces seen this run", async () => {
  const { api, detachWeb } = setup([
    API_TO_WEB,
    { id: "web-to-api", from: "web", to: "api", access: "read-only" },
  ]);
  api.ask({ _tag: "ListLinks", id: "links-1" });
  await eventually(() =>
    assert.deepEqual(replies(api), [
      {
        _tag: "ListLinks",
        id: "links-1",
        links: [
          {
            environmentId: "env-web",
            label: "Web",
            access: "approval-required",
            connected: true,
          },
        ],
      },
    ]),
  );
  detachWeb();
  api.ask({ _tag: "ListLinks", id: "links-2" });
  await eventually(() => assert.equal(replies(api).length, 2));
  assert.equal((replies(api)[1]?.links as Array<{ connected: boolean }>)[0]?.connected, false);
});

test("leaves helpers older than protocol 3 alone", () => {
  const hub = makeCoderHub({ config: () => config([API_TO_WEB]) });
  const old = fakeHelper("env-old", 2);
  hub.attach("api", old.connection);
  assert.deepEqual(old.sent, []);
});
