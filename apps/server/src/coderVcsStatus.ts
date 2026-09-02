import type {
  GitManagerServiceError,
  VcsRefStatusStreamEvent,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ServerSettings from "./serverSettings.ts";

interface StatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

export class CoderVcsStatus extends Context.Service<
  CoderVcsStatus,
  {
    readonly refresh: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly stream: (cwd: string) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
    readonly refStream: (
      cwd: string,
    ) => Stream.Stream<VcsRefStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/coderVcsStatus") {}

export const layer = Layer.effect(
  CoderVcsStatus,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const changes = yield* PubSub.unbounded<StatusChange>();
    const readLocal = (cwd: string) => workflow.localStatus({ cwd });
    const readRemote = (cwd: string, fetch: boolean) => workflow.remoteStatus({ cwd }, { fetch });
    const refresh = Effect.fn("CoderVcsStatus.refresh")(function* (cwd: string) {
      yield* workflow.invalidateStatus(cwd);
      const local = yield* readLocal(cwd);
      yield* PubSub.publish(changes, {
        cwd,
        event: { _tag: "localUpdated" as const, local },
      });
      const remote = yield* readRemote(cwd, true);
      yield* PubSub.publish(changes, {
        cwd,
        event: { _tag: "remoteUpdated" as const, remote },
      });
      return mergeGitStatusParts(local, remote);
    });
    return CoderVcsStatus.of({
      refresh,
      stream: (cwd) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const local = yield* readLocal(cwd);
            const remote = yield* readRemote(cwd, true);
            const interval = Option.isSome(settings)
              ? yield* settings.value.getSettings.pipe(
                  Effect.map((value) => value.automaticGitFetchInterval),
                  Effect.orElseSucceed(() => Duration.seconds(15)),
                )
              : Duration.seconds(15);
            const subscriptionChanges = Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.cwd === cwd),
              Stream.map((change) => change.event),
            );
            const pollingChanges =
              Duration.toMillis(interval) <= 0
                ? (Stream.empty as Stream.Stream<VcsStatusStreamEvent>)
                : Stream.tick(interval).pipe(
                    Stream.drop(1),
                    Stream.mapEffect(() =>
                      Effect.all([readLocal(cwd), readRemote(cwd, true)] as const).pipe(
                        Effect.map(Result.succeed),
                        Effect.catch((cause) =>
                          Effect.logWarning("Coder VCS status polling cycle failed", {
                            cwd,
                            cause,
                          }).pipe(Effect.as(Result.failVoid)),
                        ),
                      ),
                    ),
                    Stream.filterMap((result) => result),
                    Stream.flatMap(([nextLocal, nextRemote]) =>
                      Stream.make(
                        { _tag: "localUpdated", local: nextLocal } satisfies VcsStatusStreamEvent,
                        {
                          _tag: "remoteUpdated",
                          remote: nextRemote,
                        } satisfies VcsStatusStreamEvent,
                      ),
                    ),
                  );
            return Stream.concat(
              Stream.make({
                _tag: "snapshot" as const,
                local,
                remote,
              }),
              Stream.merge(subscriptionChanges, pollingChanges),
            );
          }),
        ),
      refStream: (cwd) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const latest = yield* workflow.localRefStatus({ cwd });
            return Stream.concat(
              Stream.make({ _tag: "snapshot" as const, local: latest }),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((change) => change.cwd === cwd),
                Stream.filterMap((change) =>
                  "local" in change.event
                    ? Result.succeed({
                        _tag: "localUpdated" as const,
                        local: {
                          isRepo: change.event.local.isRepo,
                          refName: change.event.local.refName,
                        },
                      })
                    : Result.failVoid,
                ),
                Stream.changesWith(
                  (left, right) =>
                    left.local.isRepo === right.local.isRepo &&
                    left.local.refName === right.local.refName,
                ),
              ),
            );
          }),
        ),
    });
  }),
);
