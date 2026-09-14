import { EnvironmentId, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPullRequestEnvironmentAtoms } from "./pullRequests.ts";

class MutationRefused extends Data.TaggedError("MutationRefused") {}

const TARGET = new ConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry };
});

it.effect("updates reviewer requests and enriched reviewers without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      let refuse = false;
      const actor = { login: "reviewer", name: "Reviewer", avatarUrl: null };
      const hostActor = { ...actor, login: "Reviewer" };
      let hostRequested = false;
      let reviewed = false;
      let pauseActivity = false;
      const activityStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            reads++;
            return { reviewers: hostRequested ? [hostActor] : [] };
          }),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.gen(function* () {
            reads++;
            if (pauseActivity) {
              pauseActivity = false;
              yield* activityStarted.open;
              return yield* Effect.never;
            }
            return {
              reviewers: hostRequested ? [hostActor] : [],
              comments: reviewed ? [{ kind: "review-comment", author: hostActor }] : [],
            };
          }),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input: { number: number }) =>
          input.number === 2
            ? Effect.never
            : Effect.sync(() => {
                reads++;
                return {
                  candidates: [{ ...actor, id: "12", kind: "user", isRequested: false }],
                  truncated: false,
                };
              }),
        [WS_METHODS.pullRequestsRequestReviewers]: (input: { requested: boolean }) =>
          refuse
            ? Effect.fail(new MutationRefused())
            : Effect.sync(() => {
                hostRequested = input.requested;
              }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "gitlab.example.com",
        },
      };
      const detail = atoms.detail(target);
      const activity = atoms.activity(target);
      const candidates = atoms.reviewerCandidates(target);
      registry.mount(detail);
      registry.mount(activity);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      const request = (requested: boolean, reference = target) =>
        Effect.promise(() =>
          atoms.requestReviewers.run(registry, {
            ...reference,
            input: { ...reference.input, reviewers: [{ id: "12", kind: "user" }], requested },
          }),
        );
      for (const operation of ["request", "refuse", "remove"]) {
        refuse = operation === "refuse";
        expect((yield* request(operation === "request"))._tag).toBe(refuse ? "Failure" : "Success");
        const expected = operation === "remove" ? [] : [actor];
        expect((yield* AtomRegistry.getResult(registry, detail)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { isRequested: operation !== "remove" },
        ]);
      }
      expect(reads).toBe(3);
      // A slow activity read started before the write must not hide the new request.
      pauseActivity = true;
      registry.refresh(activity);
      yield* activityStarted.await;
      expect(AsyncResult.isSuccess(yield* request(true))).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).reviewers,
      ).toEqual([hostActor]);
      expect(reads).toBe(5);
      expect(AsyncResult.isSuccess(yield* request(false))).toBe(true);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([]);

      reviewed = true;
      yield* request(true);
      registry.refresh(activity);
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* request(false);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([hostActor]);

      // A caller without an open picker still needs authoritative reviewer identities.
      const otherTarget = { ...target, input: { ...target.input, number: 2 } };
      const otherDetail = atoms.detail(otherTarget);
      registry.mount(otherDetail);
      yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true });
      yield* request(true, otherTarget);
      expect(
        (yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true }))
          .reviewers,
      ).toEqual([hostActor]);
    }),
  ),
);
