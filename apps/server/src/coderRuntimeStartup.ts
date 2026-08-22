import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

export class CoderRuntimeStartupError extends Schema.TaggedErrorClass<CoderRuntimeStartupError>()(
  "CoderRuntimeStartupError",
  { cause: Schema.Defect() },
) {}

export class CoderRuntimeStartup extends Context.Service<
  CoderRuntimeStartup,
  {
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | CoderRuntimeStartupError>;
  }
>()("t3/coderRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

export const makeCommandGate = Effect.gen(function* () {
  const ready = yield* Deferred.make<void>();
  const queue = yield* Queue.unbounded<QueuedCommand>();
  const isReady = yield* Ref.make(false);
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(queue).pipe(Effect.flatMap((command) => command.run))),
  );

  return {
    signalReady: Ref.set(isReady, true).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        if (yield* Ref.get(isReady)) return yield* effect;
        const result = yield* Deferred.make<A, E | CoderRuntimeStartupError>();
        yield* Queue.offer(queue, {
          run: Deferred.await(ready).pipe(
            Effect.andThen(effect),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit)
                ? Deferred.succeed(result, exit.value)
                : Deferred.failCause(result, exit.cause),
            ),
            Effect.asVoid,
          ),
        });
        return yield* Deferred.await(result);
      }),
  };
});

const DEFAULT_CLAUDE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5",
} as const;

export const autoBootstrapWorkspace = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  const existingProject = yield* projections.getActiveProjectByWorkspaceRoot(config.cwd);
  let projectId: ProjectId;
  let defaultModelSelection: ModelSelection = DEFAULT_CLAUDE_MODEL_SELECTION;
  if (Option.isSome(existingProject)) {
    projectId = existingProject.value.id;
    defaultModelSelection =
      existingProject.value.defaultModelSelection ?? DEFAULT_CLAUDE_MODEL_SELECTION;
  } else {
    projectId = ProjectId.make(yield* crypto.randomUUIDv4);
    yield* orchestration.dispatch({
      type: "project.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId,
      title: path.basename(config.cwd) || "workspace",
      workspaceRoot: config.cwd,
      defaultModelSelection,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  }

  const existingThread = yield* projections.getFirstActiveThreadIdByProjectId(projectId);
  if (Option.isSome(existingThread)) {
    return { bootstrapProjectId: projectId, bootstrapThreadId: existingThread.value } as const;
  }

  const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* orchestration.dispatch({
    type: "thread.create",
    commandId: CommandId.make(yield* crypto.randomUUIDv4),
    threadId,
    projectId,
    title: "New thread",
    modelSelection: defaultModelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  return { bootstrapProjectId: projectId, bootstrapThreadId: threadId } as const;
});
