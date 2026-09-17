// Adapted from upstream serverRuntimeStartup: workspace-owned restart recovery.
import { CommandId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ServerSettings from "./serverSettings.ts";
const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
const SERVER_UPDATE_CONTINUATION_KEY = "continueAfterServerUpdate";
const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";

class ProviderSessionContinuationError extends Schema.TaggedError<ProviderSessionContinuationError>()(
  "ProviderSessionContinuationError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Could not continue thread '${this.threadId}': the provider instance is missing.`;
  }
}

function hasServerUpdateContinuationMarker(
  runtimePayload: unknown,
): runtimePayload is Record<string, unknown> {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    SERVER_UPDATE_CONTINUATION_KEY in runtimePayload
  );
}

function readRuntimePayload(runtimePayload: unknown): Record<string, unknown> {
  return runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload)
    ? (runtimePayload as Record<string, unknown>)
    : {};
}

function readServerUpdateContinuationTurnId(runtimePayload: unknown): TurnId | null {
  if (!hasServerUpdateContinuationMarker(runtimePayload)) {
    return null;
  }
  const value = runtimePayload[SERVER_UPDATE_CONTINUATION_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : null;
}

const clearContinuationMarkers = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              directory.upsert({
                ...binding,
                runtimePayload: {
                  ...readRuntimePayload(binding.runtimePayload),
                  [SERVER_UPDATE_CONTINUATION_KEY]: null,
                  continueAfterServerUpdatePrepared: null,
                },
              }),
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const restartSettings = yield* settings.getSettings.pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      Effect.logWarning("could not read restart continuation preference", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  const continueAfterRestartFor = (projectId: ProjectId) =>
    Option.isSome(restartSettings)
      ? resolveProjectSettings(restartSettings.value, projectId).settings
          .continueThreadsAfterServerUpdate
      : false;

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  // Provider startup can report ready before the continuation is submitted.
  // Find those markers in one read rather than querying every idle thread.
  const preparedThreadIds = new Set(
    (yield* directory.listBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to read prepared provider continuations", { cause }).pipe(
          Effect.andThen(
            Effect.forEach(
              threads.filter(
                (thread) => thread.session?.status === "ready" && !liveThreadIds.has(thread.id),
              ),
              (thread) =>
                directory.getBinding(thread.id).pipe(Effect.orElseSucceed(() => Option.none())),
            ),
          ),
          Effect.map((bindings) =>
            bindings.flatMap((binding) => (Option.isSome(binding) ? [binding.value] : [])),
          ),
        ),
      ),
    ))
      .filter(
        (binding) =>
          readServerUpdateContinuationTurnId(binding.runtimePayload) !== null &&
          readRuntimePayload(binding.runtimePayload).activeTurnId === null &&
          readRuntimePayload(binding.runtimePayload).continueAfterServerUpdatePrepared === true,
      )
      .map((binding) => binding.threadId),
  );
  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null ||
        (thread.session.status === "ready" && preparedThreadIds.has(thread.id))) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    const binding = yield* directory.getBinding(thread.id).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to read orphaned provider session directory binding", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(Option.none())),
      ),
    );
    const continuationMarkerPresent =
      Option.isSome(binding) && hasServerUpdateContinuationMarker(binding.value.runtimePayload);
    const continuationTurnId = Option.isSome(binding)
      ? readServerUpdateContinuationTurnId(binding.value.runtimePayload)
      : null;
    const continuationMarked =
      continuationTurnId !== null &&
      (session.activeTurnId === null || continuationTurnId === session.activeTurnId) &&
      Option.isSome(binding) &&
      (session.activeTurnId !== null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId == null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId === continuationTurnId);
    const preparedWhileReady =
      session.status === "ready" &&
      session.activeTurnId === null &&
      continuationMarked &&
      Option.isSome(binding) &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === null &&
      readRuntimePayload(binding.value.runtimePayload).continueAfterServerUpdatePrepared === true;
    // Runtime events advance the projection's turn, but not the directory's
    // last admitted turn. Use the projection to identify interrupted work.
    const interruptedByRestart =
      continueAfterRestartFor(thread.projectId) &&
      session.status === "running" &&
      session.activeTurnId !== null &&
      Option.isSome(binding) &&
      binding.value.status === "running" &&
      binding.value.resumeCursor != null;
    const settleAsError = (lastError: string) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          if (Option.isSome(binding)) {
            yield* directory.upsert({
              ...binding.value,
              status: "stopped",
              runtimePayload: {
                ...readRuntimePayload(binding.value.runtimePayload),
                activeTurnId: null,
                ...(continuationMarkerPresent || interruptedByRestart
                  ? {
                      [SERVER_UPDATE_CONTINUATION_KEY]: null,
                      continueAfterServerUpdatePrepared: null,
                    }
                  : {}),
              },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "failed to reconcile orphaned provider session directory binding",
                  { threadId: thread.id, cause },
                ),
          ),
        );

        yield* Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: thread.id,
            session: {
              ...session,
              status: "error",
              activeTurnId: null,
              lastError,
              updatedAt: reconciledAt,
            },
            createdAt: reconciledAt,
          });
        }).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("failed to settle orphaned provider session projection", {
                  threadId: thread.id,
                  cause,
                }),
          ),
        );
      });

    if (
      Option.isSome(binding) &&
      (continuationMarked || interruptedByRestart) &&
      (session.status === "running" || session.status === "starting" || preparedWhileReady) &&
      binding.value.resumeCursor != null &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    ) {
      const prepared = yield* Effect.gen(function* () {
        yield* directory.upsert({
          ...binding.value,
          status: "starting",
          runtimePayload: {
            ...readRuntimePayload(binding.value.runtimePayload),
            // Keep recovery durable if this process also exits before sending.
            [SERVER_UPDATE_CONTINUATION_KEY]: session.activeTurnId ?? continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
          },
        });
        const resumedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: resumedAt,
          },
          createdAt: resumedAt,
        });
      }).pipe(Effect.retry({ times: 1 }), Effect.exit);
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) {
          return yield* Effect.failCause(prepared.cause);
        }
        yield* Effect.logWarning("failed to prepare provider session continuation", {
          threadId: thread.id,
          cause: prepared.cause,
        });
        yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
        continue;
      }

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const continuation = Effect.gen(function* () {
            const providerInstanceId = binding.value.providerInstanceId;
            if (providerInstanceId === undefined) {
              return yield* new ProviderSessionContinuationError({
                threadId: thread.id,
              });
            }
            yield* providerService.sendTurn({
              threadId: thread.id,
              input: SERVER_UPDATE_CONTINUATION_PROMPT,
              interactionMode: thread.interactionMode,
            });
          });
          const continuationExit = yield* Effect.exit(continuation);
          if (Exit.isSuccess(continuationExit) || Cause.hasInterrupts(continuationExit.cause)) {
            if (Exit.isSuccess(continuationExit)) {
              yield* clearContinuationMarkers(directory, [thread.id]).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to clear completed provider session continuation", {
                    threadId: thread.id,
                    cause,
                  }),
                ),
              );
            }
            return;
          }
          yield* Effect.logWarning("failed to continue provider session after server restart", {
            threadId: thread.id,
            cause: continuationExit.cause,
          });
          yield* settleAsError(
            "Could not continue this thread after the server restart. Send a new message to continue.",
          ).pipe(Effect.ignoreCause);
        }),
      );
      continue;
    }

    yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);
