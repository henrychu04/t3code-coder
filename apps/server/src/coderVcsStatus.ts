import type {
  GitManagerServiceError,
  VcsRefStatusStreamEvent,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "./serverSettings.ts";
import { automaticPullSkipReason } from "./vcs/projectAutoPull.ts";

interface StatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

export class CoderVcsStatus extends Context.Service<
  CoderVcsStatus,
  {
    readonly refresh: (
      cwd: string,
      options?: { readonly fetch?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
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
    const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery.ProjectionSnapshotQuery);
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const changes = yield* PubSub.unbounded<StatusChange>();
    // As in upstream's broadcaster, hold one permit across reads, auto-pull and
    // publication so an older operation cannot overwrite a newer result.
    const repositoryLocks = new Map<string, Semaphore.Semaphore>();
    const withRepositoryLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
      let lock = repositoryLocks.get(cwd);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        repositoryLocks.set(cwd, lock);
      }
      return lock.withPermits(1)(effect);
    };
    const readLocal = (cwd: string) => workflow.localStatus({ cwd });
    const readRemote = (cwd: string, fetch: boolean) => workflow.remoteStatus({ cwd }, { fetch });
    const maybeAutoPull = Effect.fn("CoderVcsStatus.maybeAutoPull")(function* (
      cwd: string,
      local: VcsStatusLocalResult,
      remote: VcsStatusRemoteResult | null,
    ) {
      return yield* Effect.gen(function* () {
        const enabled = Option.isSome(snapshots)
          ? yield* snapshots.value.getActiveProjectByWorkspaceRoot(cwd).pipe(
              Effect.map((project) => Option.isSome(project) && project.value.autoPull === true),
              Effect.orElseSucceed(() => false),
            )
          : false;
        if (
          !enabled ||
          remote === null ||
          !remote.hasUpstream ||
          remote.aheadCount > 0 ||
          remote.behindCount <= 0
        ) {
          return [local, remote] as const;
        }

        yield* workflow.invalidateStatus(cwd);
        const freshLocal = yield* readLocal(cwd);
        if (automaticPullSkipReason(freshLocal, remote) !== null) {
          return [freshLocal, remote] as const;
        }
        yield* workflow.pull({ cwd }, { automatic: true });
        yield* workflow.invalidateStatus(cwd);
        return yield* Effect.all([readLocal(cwd), readRemote(cwd, false)] as const, {
          concurrency: "unbounded",
        });
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Automatic project pull failed", { cwd }).pipe(
            Effect.as([local, remote] as const),
          ),
        ),
      );
    });
    const readStatus = (cwd: string, fetch: boolean) =>
      Effect.all([readLocal(cwd), readRemote(cwd, fetch)] as const, {
        concurrency: "unbounded",
      }).pipe(
        Effect.flatMap(([local, remote]) =>
          fetch ? maybeAutoPull(cwd, local, remote) : Effect.succeed([local, remote] as const),
        ),
      );
    const refresh = Effect.fn("CoderVcsStatus.refresh")(function* (
      cwd: string,
      options?: { readonly fetch?: boolean },
    ) {
      return yield* withRepositoryLock(
        cwd,
        Effect.gen(function* () {
          yield* workflow.invalidateStatus(cwd);
          const [local, remote] = yield* readStatus(cwd, options?.fetch !== false);
          yield* PubSub.publish(changes, {
            cwd,
            event: { _tag: "localUpdated" as const, local },
          });
          yield* PubSub.publish(changes, {
            cwd,
            event: { _tag: "remoteUpdated" as const, remote },
          });
          return mergeGitStatusParts(local, remote);
        }),
      );
    });
    // One polling fiber per subscribed repository; RcMap stops it with the last subscriber.
    const pollers = yield* RcMap.make({
      lookup: (cwd: string) =>
        Effect.gen(function* () {
          const settingsChanges = Option.isSome(settings)
            ? yield* settings.value.subscribeChanges
            : Stream.empty;
          const interval = Option.isSome(settings)
            ? yield* settings.value.getSettings.pipe(
                Effect.map((value) => value.automaticGitFetchInterval),
                Effect.orElseSucceed(() => Duration.seconds(15)),
              )
            : Duration.seconds(15);
          const polling = Stream.concat(
            Stream.succeed(interval),
            Stream.concat(
              settingsChanges.pipe(Stream.map((value) => value.automaticGitFetchInterval)),
              Stream.never,
            ),
          ).pipe(
            Stream.changesWith((a, b) => Duration.toMillis(a) === Duration.toMillis(b)),
            Stream.switchMap((interval) =>
              Duration.toMillis(interval) <= 0
                ? Stream.empty
                : Stream.tick(interval).pipe(
                    Stream.drop(1),
                    Stream.mapEffect(() =>
                      refresh(cwd).pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning("Coder VCS status polling cycle failed", {
                            cwd,
                            cause,
                          }),
                        ),
                      ),
                    ),
                  ),
            ),
          );
          yield* polling.pipe(Stream.runDrain, Effect.forkScoped);
        }),
    });
    return CoderVcsStatus.of({
      refresh,
      stream: (cwd) =>
        Stream.unwrap(
          withRepositoryLock(
            cwd,
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(changes);
              yield* RcMap.get(pollers, cwd);
              const [local, remote] = yield* readStatus(cwd, true);
              const subscriptionChanges = Stream.fromSubscription(subscription).pipe(
                Stream.filter((change) => change.cwd === cwd),
                Stream.map((change) => change.event),
              );
              return Stream.concat(
                Stream.make({
                  _tag: "snapshot" as const,
                  local,
                  remote,
                }),
                subscriptionChanges,
              );
            }),
          ),
        ),
      refStream: (cwd) =>
        Stream.unwrap(
          withRepositoryLock(
            cwd,
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
        ),
    });
  }),
);
