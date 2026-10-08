import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { makeThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

type Supervisor = EnvironmentSupervisor.EnvironmentSupervisor["Service"];

describe("Coder thread snapshot loader", () => {
  it.effect("loads bounded snapshots and older pages through the current helper session", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      const bounded = {
        snapshotSequence: 4,
        projection: {},
        historyCursor: "older",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 3,
      } as unknown as OrchestrationV2ThreadBoundedSnapshot;
      const page = {
        snapshotSequence: 4,
        items: [],
        nextCursor: null,
        hasMoreHistory: false,
      } satisfies OrchestrationV2ThreadHistoryPage;
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.orchestrationGetThreadBoundedSnapshot]: (input: unknown) =>
              Effect.sync(() => {
                inputs.push(input);
                return bounded;
              }),
            [WS_METHODS.orchestrationGetThreadHistoryPage]: (input: unknown) =>
              Effect.sync(() => {
                inputs.push(input);
                return page;
              }),
          },
        } as unknown as RpcSession),
      );
      const supervisor = { session } as unknown as Supervisor;
      const loader = makeThreadSnapshotLoader(supervisor);
      const threadId = ThreadId.make("thread");

      expect(yield* loader.load({} as PreparedConnection, threadId)).toEqual({
        _tag: "present",
        snapshot: { snapshotSequence: 4, projection: {}, latestLocalTurnOrdinal: 3 },
        history: { historyCursor: "older", hasMoreHistory: true, latestLocalTurnOrdinal: 3 },
      });
      expect(
        yield* fetchEnvironmentThreadHistoryPage({ supervisor, threadId, cursor: "older" }),
      ).toEqual(page);
      expect(inputs).toEqual([{ threadId }, { threadId, cursor: "older" }]);

      yield* SubscriptionRef.set(session, Option.none());
      expect(yield* loader.load({} as PreparedConnection, threadId)).toEqual({
        _tag: "unavailable",
      });
      expect(inputs).toHaveLength(2);
    }),
  );

  it.effect("defers failed RPC reads to upstream's socket snapshot fallback", () =>
    Effect.gen(function* () {
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.orchestrationGetThreadBoundedSnapshot]: () =>
              Effect.fail(new Error("missing snapshot")),
          },
        } as unknown as RpcSession),
      );
      const loader = makeThreadSnapshotLoader({ session } as unknown as Supervisor);
      expect(yield* loader.load({} as PreparedConnection, ThreadId.make("missing"))).toEqual({
        _tag: "unavailable",
      });
    }),
  );
});
