/**
 * Coder: the workspace helper's side of the gateway hub (helper protocol v3).
 *
 * Upstream links two T3 Code servers over HTTP `/mcp`. Here the laptop gateway holds every
 * workspace's helper connection, so a call bound for another workspace goes out through this
 * outbox: the gateway subscribes to it (`coder.hub.outbox`), runs the call on the other
 * workspace's helper (`coder.hub.invoke`), and answers here (`coder.hub.reply`). Nothing
 * listens and nothing leaves the workspace except this helper's stdio.
 *
 * @module coderHub
 */
import {
  CODER_HUB_INVOKE_METHOD,
  CODER_HUB_OUTBOX_METHOD,
  CODER_HUB_REPLY_METHOD,
  type CoderHubCallLimits,
  type CoderHubCallOutcome,
  type CoderHubLink,
  type CoderHubReply,
  type CoderHubRequest,
  CoderHubRpcGroup,
} from "@t3tools/coder-cli/rpc";
import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerEnvironmentIdentity } from "./coderEnvironment.ts";
import { T3ToolDispatch } from "./mcp/bridge/T3ToolDispatch.ts";
import type * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as ServerSettings from "./serverSettings.ts";

/** How long one call waits for the gateway's answer; forwarded waits go in 50 s pieces. */
export const CODER_HUB_CALL_TIMEOUT = Duration.minutes(2);

/** The gateway's answer before it is matched to a request kind. */
type Pending = Deferred.Deferred<CoderHubReply, OrchestratorMcpFailure>;

const hubFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const noGateway = hubFailure(
  "This workspace cannot reach other workspaces: T3 Coder's gateway is not routing between them.",
);
const shuttingDown = hubFailure("This workspace is shutting down.");
const timedOut = hubFailure("The other workspace did not answer in time.");

export class CoderHub extends Context.Service<
  CoderHub,
  {
    /**
     * The gateway's subscription. A new one replaces the previous, whose stream ends and whose
     * unanswered requests fail.
     */
    readonly outbox: Stream.Stream<CoderHubRequest>;
    /** The gateway's answer to an outbox request; an unknown id is ignored. */
    readonly reply: (reply: CoderHubReply) => Effect.Effect<void>;
    /** Runs `tool` in another workspace and returns its outcome there. */
    readonly call: (input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: CoderHubCallLimits;
    }) => Effect.Effect<CoderHubCallOutcome, OrchestratorMcpFailure>;
    /** The gateway's link rules from this workspace. */
    readonly listLinks: Effect.Effect<ReadonlyArray<CoderHubLink>, OrchestratorMcpFailure>;
  }
>()("t3/coderHub") {}

interface Subscriber {
  readonly generation: number;
  readonly queue: Queue.Queue<CoderHubRequest, Cause.Done>;
  readonly pending: Set<string>;
}

export const make = Effect.gen(function* () {
  const subscriber = yield* Ref.make<Subscriber | undefined>(undefined);
  const pending = new Map<string, Pending>();
  let nextGeneration = 0;
  let nextId = 0;
  let closed = false;

  const failPending = (ids: Iterable<string>, failure: OrchestratorMcpFailure) =>
    Effect.forEach(
      Array.from(ids),
      (id) => {
        const deferred = pending.get(id);
        pending.delete(id);
        return deferred === undefined ? Effect.void : Deferred.fail(deferred, failure);
      },
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      const current = yield* Ref.getAndSet(subscriber, undefined);
      if (current !== undefined) yield* Queue.end(current.queue);
      yield* failPending(pending.keys(), shuttingDown);
    }),
  );

  const outbox: CoderHub["Service"]["outbox"] = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CoderHubRequest, Cause.Done>();
      const own: Subscriber = { generation: nextGeneration++, queue, pending: new Set() };
      const previous = yield* Ref.getAndSet(subscriber, own);
      if (previous !== undefined) {
        yield* Queue.end(previous.queue);
        yield* failPending(previous.pending, noGateway);
      }
      yield* Effect.addFinalizer(() =>
        Ref.modify(subscriber, (current) =>
          current?.generation === own.generation
            ? ([true, undefined] as const)
            : ([false, current] as const),
        ).pipe(
          Effect.flatMap((wasCurrent) =>
            wasCurrent
              ? Queue.end(queue).pipe(Effect.andThen(failPending(own.pending, noGateway)))
              : Effect.void,
          ),
        ),
      );
      return Stream.fromQueue(queue);
    }),
  );

  /** Sends a request to the gateway and waits for its answer. */
  const request = <A>(
    build: (id: string) => CoderHubRequest,
    read: (reply: CoderHubReply) => A | undefined,
  ): Effect.Effect<A, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      if (closed) return yield* shuttingDown;
      const current = yield* Ref.get(subscriber);
      if (current === undefined) return yield* noGateway;
      const id = `hub:${String(nextId++)}`;
      const deferred = yield* Deferred.make<CoderHubReply, OrchestratorMcpFailure>();
      pending.set(id, deferred);
      current.pending.add(id);
      const answer = yield* Queue.offer(current.queue, build(id)).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOrElse({
          duration: CODER_HUB_CALL_TIMEOUT,
          orElse: () => Effect.fail(timedOut),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
            current.pending.delete(id);
          }),
        ),
      );
      const value = read(answer);
      if (value === undefined) {
        return yield* hubFailure("T3 Coder's gateway answered with the wrong kind of reply.");
      }
      return value;
    });

  return CoderHub.of({
    outbox,
    reply: (reply) =>
      Effect.suspend(() => {
        const deferred = pending.get(reply.id);
        return deferred === undefined ? Effect.void : Deferred.succeed(deferred, reply);
      }).pipe(Effect.asVoid),
    call: (input) =>
      request(
        (id) => ({ _tag: "Call", id, ...input }),
        (reply) => (reply._tag === "Call" ? reply.outcome : undefined),
      ),
    listLinks: request(
      (id) => ({ _tag: "ListLinks", id }),
      (reply) => (reply._tag === "ListLinks" ? reply.links : undefined),
    ),
  });
});

export const layer = Layer.effect(CoderHub, make);

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const decodeFailure = Schema.decodeUnknownOption(OrchestratorMcpFailure);

/** The agent-facing failure of a call that failed here, in the shape the caller decodes. */
const toCallFailure = (value: unknown): OrchestratorMcpFailure => {
  if (isOrchestratorMcpFailure(value)) return value;
  const decoded = decodeFailure(value);
  if (decoded._tag === "Some") return decoded.value;
  const message =
    typeof value === "object" && value !== null && "message" in value
      ? String(value.message)
      : "The T3 tool failed in the linked workspace.";
  return hubFailure(message);
};

/**
 * The hub methods the gateway calls. `invoke` runs a tool here as the link's caller, as upstream's
 * `/mcp` runs a linked environment's OAuth session: what it starts here carries the link as its
 * origin, its modes are capped by the calling agent's, and the Labs beta must be on here.
 */
export const makeHandlers = Effect.gen(function* () {
  const hub = yield* CoderHub;
  const tools = yield* T3ToolDispatch;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environmentId = yield* ServerEnvironmentIdentity.pipe(
    Effect.flatMap((identity) => identity.getEnvironmentId),
  );

  const invoke = Effect.fn("CoderHub.invoke")(function* (input: {
    readonly link: {
      readonly id: string;
      readonly label: string;
      readonly access: McpInvocationContext.McpClientCaller["access"];
    };
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly limits: CoderHubCallLimits;
  }) {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.linkedEnvironmentsEnabled),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) {
      return {
        _tag: "Failure",
        // As upstream's PeerMcpClient: not final, so a task already running here resumes once
        // the beta is on here again.
        failure: new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "The linked workspace has Linked environments turned off. Turn it on in its Settings → Labs.",
        }),
      } satisfies CoderHubCallOutcome;
    }
    const binding = yield* tools.binding;
    if (binding === undefined) {
      return {
        _tag: "Failure",
        failure: hubFailure("That workspace is starting. Retry shortly."),
      } satisfies CoderHubCallOutcome;
    }
    const sessionId = `coder-link:${input.link.id}`;
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: `client:${sessionId}`,
      thread: undefined,
      client: {
        sessionId,
        label: input.link.label,
        access: input.link.access,
        linked: true,
        narrowedTo: input.limits,
      },
      capabilities: new Set<McpInvocationContext.McpCapability>([
        "orchestration",
        "worktree",
        "pull-requests",
      ]),
      issuedAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      linkedEnvironments: true,
    };
    return yield* binding
      .invoke(scope, { id: sessionId, tool: input.tool, params: { ...input.arguments } })
      .pipe(
        Effect.map((value): CoderHubCallOutcome => ({ _tag: "Success", value })),
        Effect.catch((error) =>
          Effect.succeed<CoderHubCallOutcome>({
            _tag: "Failure",
            failure: toCallFailure(error.value),
          }),
        ),
      );
  });

  return CoderHubRpcGroup.of({
    [CODER_HUB_OUTBOX_METHOD]: () => hub.outbox,
    [CODER_HUB_REPLY_METHOD]: (reply) => hub.reply(reply),
    [CODER_HUB_INVOKE_METHOD]: invoke,
  });
});

export const handlersLayer = CoderHubRpcGroup.toLayer(makeHandlers);
