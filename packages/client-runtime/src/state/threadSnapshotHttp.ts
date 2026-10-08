import {
  type OrchestrationV2ThreadDetailSnapshot,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { PreparedConnection } from "../connection/model.ts";
import type * as EnvironmentSupervisor from "../connection/supervisor.ts";

/** Progressive history metadata returned by a bounded snapshot loader. */
export type ThreadSnapshotHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  /** Max local turn ordinal from the full projection; optional on older servers. */
  readonly latestLocalTurnOrdinal?: number | null;
};

/**
 * Outcome of a thread-detail snapshot load.
 *
 * - `present`: snapshot body is available (seed projection, resume via socket).
 * - `missing`: server definitively reported the thread does not exist (404).
 * - `unavailable`: transport/timeout/5xx/etc.; fall back to the socket path.
 */
export type ThreadSnapshotLoadResult =
  | {
      readonly _tag: "present";
      readonly snapshot: OrchestrationV2ThreadDetailSnapshot;
      readonly history?: ThreadSnapshotHistoryMeta;
    }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadSnapshotLoadResult>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

/**
 * Coder: bounded snapshots use the current helper stdio session instead of the
 * environment HTTP route. Any failure falls back to the socket snapshot, which
 * also reports a missing thread.
 */
export function makeThreadSnapshotLoader(
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
): ThreadSnapshotLoader["Service"] {
  return ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Effect.gen(function* () {
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session)) return { _tag: "unavailable" } as const;
        return yield* session.value.client[WS_METHODS.orchestrationGetThreadBoundedSnapshot]({
          threadId,
        }).pipe(
          Effect.map((bounded): ThreadSnapshotLoadResult => ({
            _tag: "present",
            snapshot: {
              snapshotSequence: bounded.snapshotSequence,
              projection: bounded.projection,
              latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            },
            history: {
              historyCursor: bounded.historyCursor,
              hasMoreHistory: bounded.hasMoreHistory,
              latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            },
          })),
          Effect.catchCause(() => Effect.succeed({ _tag: "unavailable" } as const)),
        );
      }),
  });
}
