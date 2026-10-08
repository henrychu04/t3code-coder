import {
  ORCHESTRATION_WS_METHODS,
  type ThreadId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentSupervisor } from "../connection/supervisor.ts";

export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      window?: ThreadSnapshotWindow,
      reasoningMessages?: boolean,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

// Coder: snapshots and older pages use the current helper stdio session. No HTTP or durable browser cache.
export function makeThreadSnapshotLoader(
  supervisor: EnvironmentSupervisor["Service"],
): ThreadSnapshotLoader["Service"] {
  return ThreadSnapshotLoader.of({
    load: (_prepared, threadId, window, reasoningMessages) =>
      Effect.gen(function* () {
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session)) return Option.none<OrchestrationThreadDetailSnapshot>();
        return yield* session.value.client[ORCHESTRATION_WS_METHODS.getThreadSnapshot]({
          threadId,
          turnLimit: window?.turnLimit ?? 10,
          ...(window?.beforeCursor === undefined ? {} : { beforeCursor: window.beforeCursor }),
          reasoningMessages: reasoningMessages === true,
          targetBytes: window?.beforeCursor === undefined ? 512 * 1024 : 1024 * 1024,
        }).pipe(
          Effect.map(Option.some),
          Effect.catchCause(() => Effect.succeed(Option.none<OrchestrationThreadDetailSnapshot>())),
        );
      }),
  });
}
