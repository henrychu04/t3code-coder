import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
// Coder: exercise the fork settings policy and lightweight ref-stream contract.
import {
  DEFAULT_SERVER_SETTINGS,
  GitManagerError,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  type VcsRefStatusStreamEvent,
} from "@t3tools/contracts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

// Coder: the demand-only policy exposes just the VCS scope used by this suite.
import type { BackgroundScope } from "../background/BackgroundPolicy.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  // Coder: source-control fixtures use the only supported hosted provider.
  sourceControlProvider: {
    kind: "gitlab",
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    // Coder: keep the merge-request fixture within the GitLab-only contract.
    url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/2978",
    baseRef: "main",
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function makeTestLayer(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  backgroundWorkEnabled?: boolean;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(makeBackgroundPolicyLayer(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, options) =>
          Effect.sync(() => {
            state.remoteStatusCalls += 1;
            state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
            return state.currentRemoteStatus;
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
      }),
    ),
  );
}

function makeBackgroundPolicyLayer(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    // Coder: omit client leases and host-power members absent from the fork policy.
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(makeBackgroundPolicyLayer(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      // Nobody loaded this cwd yet: no host request is spent.
      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      // Loaded and no PR known: ask GitManager to retry the missing PR.
      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);

      // The agent switches branches. The previous branch's PR must not block a read.
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                // Hold an older empty response while the turn-end refresh queues.
                yield* Deferred.succeed(firstPollStarted, undefined);
                yield* Deferred.await(releaseFirstPoll);
                return baseRemoteStatus;
              }
              return remoteReads === 1 ? baseRemoteStatus : remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const poll = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(firstPollStarted);
      const refresh = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirstPoll, undefined);
      yield* Fiber.join(poll);
      const refreshed = yield* Fiber.join(refresh);

      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      const final = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(final.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      // Run ready fibers before releasing the delayed first read.
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("turn-end refresh skips a loaded cwd when background policy pauses it", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("keeps the cached snapshot unchanged when a refresh branch fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.deepStrictEqual(cached, baseStatus);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("refreshes only the cached local snapshot when requested", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(makeBackgroundPolicyLayer(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("streams a local snapshot first and remote updates later", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "remoteUpdated") {
          return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: baseRemoteStatus,
      } satisfies VcsStatusStreamEvent);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("loads remote status once when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false]);

      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it.effect("retries the initial remote load when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };
    const privateCwd = "/private/user/workspace/repo";
    const nestedCause = new Error("private nested VCS failure");
    const messages: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message as ReadonlyArray<unknown>);
    });
    let firstRemoteAttemptDeferred: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (_input, options) =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              state.remoteStatusRefreshUpstreamValues.push(options?.refreshUpstream);
              if (state.remoteStatusCalls === 1) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "VcsStatusBroadcaster.test",
                    cwd: privateCwd,
                    detail: "private initial remote status failure",
                    cause: nestedCause,
                  }),
                ).pipe(
                  Effect.ensuring(
                    firstRemoteAttemptDeferred
                      ? Deferred.succeed(firstRemoteAttemptDeferred, undefined).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                );
              }
              return Effect.succeed(remoteStatusWithPr);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      firstRemoteAttemptDeferred = yield* Deferred.make<void>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: privateCwd },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) =>
          event._tag === "remoteUpdated"
            ? Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(firstRemoteAttemptDeferred);
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 1);
      assert.deepStrictEqual(
        messages.find((message) => message[0] === "VCS remote status refresh failed"),
        [
          "VCS remote status refresh failed",
          {
            cwdLength: privateCwd.length,
            reasonCount: 1,
            failureCount: 1,
            failureTags: ["GitManagerError"],
            failureOperations: ["VcsStatusBroadcaster.test"],
            defectCount: 0,
            defectTags: [],
            interruptionCount: 0,
            consecutiveFailures: 1,
            nextDelayMs: 30_000,
          },
        ],
      );

      yield* TestClock.adjust(Duration.seconds(30));
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false, false]);

      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("delays automatic refresh when a cached remote snapshot is available", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 1);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      30_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      60_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it("summarizes refresh causes without exposing nested failure details", () => {
    const nestedCause = new Error("private nested failure detail");
    const failure = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/private/user/workspace/repo",
      detail: "private Git failure detail",
      cause: nestedCause,
    });
    const cause = Cause.combine(Cause.fail(failure), Cause.die(new TypeError("private defect")));

    assert.deepStrictEqual(VcsStatusBroadcaster.remoteRefreshFailureDiagnostics(cause), {
      reasonCount: 2,
      failureCount: 1,
      failureTags: ["GitManagerError"],
      failureOperations: ["VcsStatusBroadcaster.remoteStatus"],
      defectCount: 1,
      defectTags: ["TypeError"],
      interruptionCount: 0,
    });
  });

  it.effect("does not start automatic remote refreshes without foreground client demand", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => false)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("stops the remote poller after the last stream subscriber disconnects", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });
});

// Coder: preserve the lightweight ref stream without index refreshes or remote polling.
describe("Coder ref status stream", () => {
  it.effect("reads only a non-mutating snapshot and never starts remote polling", () => {
    let localReads = 0;
    let remoteReads = 0;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(BackgroundPolicy.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localRefStatus: () => Effect.succeed({ isRepo: true, refName: "main" }),
          localStatus: () =>
            Effect.sync(() => {
              localReads++;
              return baseLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              remoteReads++;
              return baseRemoteStatus;
            }),
          invalidateRemoteStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const ready = yield* Deferred.make<VcsRefStatusStreamEvent>();
      const observer = yield* broadcaster.streamRefStatus("/repo").pipe(
        Stream.runForEach((event) => Deferred.succeed(ready, event)),
        Effect.forkChild,
      );
      assert.deepStrictEqual(yield* Deferred.await(ready), {
        _tag: "snapshot",
        local: { isRepo: true, refName: "main" },
      });
      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(localReads, 0);
      assert.equal(remoteReads, 0);
      yield* Fiber.interrupt(observer);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect(
    "maps local updates and full snapshots, filters other repositories, and dedupes refs",
    () => {
      let local = baseLocalStatus;
      let remote = baseRemoteStatus;
      const events: Array<VcsRefStatusStreamEvent> = [];
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(BackgroundPolicy.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localRefStatus: () => Effect.succeed({ isRepo: local.isRepo, refName: local.refName }),
            localStatus: () => Effect.sync(() => local),
            remoteStatus: () => Effect.sync(() => remote),
            invalidateLocalStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const ready = yield* Deferred.make<void>();
        const observer = yield* broadcaster.streamRefStatus("/repo").pipe(
          Stream.runForEach((event) => {
            events.push(event);
            return Deferred.succeed(ready, undefined);
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* broadcaster.refreshLocalStatus("/other");
        yield* broadcaster.refreshLocalStatus("/repo");
        local = { ...local, hasWorkingTreeChanges: true };
        yield* broadcaster.refreshLocalStatus("/repo");
        yield* broadcaster.refreshStatus("/repo");
        // A remote-only change must not appear in the ref stream.
        remote = { ...remote, aheadCount: 1 };
        yield* broadcaster.refreshPullRequestStatus("/repo");
        local = { ...local, refName: "feature/new" };
        yield* broadcaster.refreshStatus("/repo");
        local = { ...local, isRepo: false };
        yield* broadcaster.refreshLocalStatus("/repo");
        yield* TestClock.adjust(Duration.zero);
        yield* Fiber.interrupt(observer);
        assert.deepStrictEqual(events, [
          { _tag: "snapshot", local: { isRepo: true, refName: baseLocalStatus.refName } },
          { _tag: "localUpdated", local: { isRepo: true, refName: baseLocalStatus.refName } },
          { _tag: "localUpdated", local: { isRepo: true, refName: "feature/new" } },
          { _tag: "localUpdated", local: { isRepo: false, refName: "feature/new" } },
        ]);
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("subscribes before reading the snapshot so concurrent local updates are retained", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(BackgroundPolicy.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localRefStatus: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ isRepo: true, refName: "main" }),
              ),
            localStatus: () => Effect.succeed({ ...baseLocalStatus, refName: "feature/new" }),
            invalidateLocalStatus: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const observer = yield* broadcaster
          .streamRefStatus("/repo")
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Deferred.await(started);
        yield* broadcaster.refreshLocalStatus("/repo");
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(Array.from(yield* Fiber.join(observer)), [
          { _tag: "snapshot", local: { isRepo: true, refName: "main" } },
          { _tag: "localUpdated", local: { isRepo: true, refName: "feature/new" } },
        ]);
      }).pipe(Effect.provide(testLayer));
    }),
  );
});

// Coder: retain legacy project opt-ins while honoring settings overrides, as startup does.
describe("Coder auto-pull policy", () => {
  const projectId = ProjectId.make("coder-auto-pull");
  const cases: Array<{
    name: string;
    autoPull: boolean | undefined;
    settings: Partial<ServerSettingsValue>;
    enabled: boolean;
  }> = [
    { name: "retains legacy project opt-ins", autoPull: true, settings: {}, enabled: true },
    { name: "defaults to disabled", autoPull: undefined, settings: {}, enabled: false },
    {
      name: "inherits the global default",
      autoPull: false,
      settings: { defaultAutoPull: true },
      enabled: true,
    },
    {
      name: "honors a legacy explicit override",
      autoPull: true,
      settings: { projectAutoPullOverrides: { [projectId]: false } },
      enabled: false,
    },
    {
      name: "prefers project settings over legacy overrides",
      autoPull: false,
      settings: {
        projectAutoPullOverrides: { [projectId]: false },
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
      enabled: true,
    },
  ];
  for (const testCase of cases) {
    it.effect(testCase.name, () => {
      let behindCount = 2;
      let pullCalls = 0;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(BackgroundPolicy.layer),
        Layer.provide(
          VcsStatusBroadcaster.autoPullPolicyLayer.pipe(
            Layer.provide(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                findActiveByWorkspaceRoot: () =>
                  Effect.succeed(
                    Option.some({
                      projectId,
                      autoPull: testCase.autoPull,
                    } as ProjectStore.ProjectRow),
                  ),
              }),
            ),
            Layer.provide(
              ServerSettings.layerTest({ ...DEFAULT_SERVER_SETTINGS, ...testCase.settings }),
            ),
          ),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () =>
              Effect.succeed({ ...baseLocalStatus, isDefaultRef: true, refName: "main" }),
            remoteStatus: () => Effect.sync(() => ({ ...baseRemoteStatus, behindCount })),
            invalidateStatus: () => Effect.void,
            invalidateLocalStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls++;
                behindCount = 0;
                return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
              }),
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.refreshStatus("/repo");
        assert.equal(pullCalls, testCase.enabled ? 1 : 0);
      }).pipe(Effect.provide(testLayer));
    });
  }
});
