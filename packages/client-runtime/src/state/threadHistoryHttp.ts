import { type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type * as EnvironmentSupervisor from "../connection/supervisor.ts";

class ThreadHistoryUnavailableError extends Schema.TaggedError<ThreadHistoryUnavailableError>()(
  "ThreadHistoryUnavailableError",
  { message: Schema.String },
) {}

/** Coder: older history pages use the current helper stdio session instead of environment HTTP. */
export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
}) {
  const session = yield* SubscriptionRef.get(input.supervisor.session);
  if (Option.isNone(session)) {
    return yield* new ThreadHistoryUnavailableError({ message: "Environment is not connected." });
  }
  return yield* session.value.client[WS_METHODS.orchestrationGetThreadHistoryPage]({
    threadId: input.threadId,
    cursor: input.cursor,
    ...(input.view === undefined ? {} : { view: input.view }),
    ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
  });
});
