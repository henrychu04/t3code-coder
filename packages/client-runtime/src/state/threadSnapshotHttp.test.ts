import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { makeThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

describe("Coder thread snapshot loader", () => {
  it.effect(
    "uses the current session for bounded initial and older pages with reasoning projection",
    () =>
      Effect.gen(function* () {
        const inputs: unknown[] = [];
        const snapshot = { snapshotSequence: 1 } as OrchestrationThreadDetailSnapshot;
        const session = yield* SubscriptionRef.make(
          Option.some({
            client: {
              [ORCHESTRATION_WS_METHODS.getThreadSnapshot]: (input: unknown) =>
                Effect.sync(() => {
                  inputs.push(input);
                  return snapshot;
                }),
            },
          } as unknown as RpcSession),
        );
        const loader = makeThreadSnapshotLoader({ session } as EnvironmentSupervisor["Service"]);
        const threadId = ThreadId.make("thread");
        expect(
          yield* loader.load({} as PreparedConnection, threadId, { turnLimit: 10 }, true),
        ).toEqual(Option.some(snapshot));
        expect(
          yield* loader.load(
            {} as PreparedConnection,
            threadId,
            { turnLimit: 20, beforeCursor: "older" },
            false,
          ),
        ).toEqual(Option.some(snapshot));
        expect(inputs).toEqual([
          { threadId, turnLimit: 10, reasoningMessages: true, targetBytes: 512 * 1024 },
          {
            threadId,
            turnLimit: 20,
            beforeCursor: "older",
            reasoningMessages: false,
            targetBytes: 1024 * 1024,
          },
        ]);
        yield* SubscriptionRef.set(session, Option.none());
        expect(yield* loader.load({} as PreparedConnection, threadId)).toEqual(Option.none());
        expect(inputs).toHaveLength(2);
      }),
  );
  it.effect("defers failed RPC reads to upstream's socket snapshot fallback", () =>
    Effect.gen(function* () {
      const session = yield* SubscriptionRef.make(
        Option.some({
          client: {
            [ORCHESTRATION_WS_METHODS.getThreadSnapshot]: () =>
              Effect.fail(new Error("missing snapshot")),
          },
        } as unknown as RpcSession),
      );
      const loader = makeThreadSnapshotLoader({ session } as EnvironmentSupervisor["Service"]);
      expect(yield* loader.load({} as PreparedConnection, ThreadId.make("missing"))).toEqual(
        Option.none(),
      );
    }),
  );
});
