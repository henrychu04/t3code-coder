import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
type AutoSettleCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "sonnet",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("ThreadSettlementReactor", () => {
  it.effect("runs without a client, coalesces branch lookups, and skips protected threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const snapshot: OrchestrationShellSnapshot = {
          snapshotSequence: 7,
          projects: [makeProject()],
          threads: [
            makeThread("inactive-one", { branch: "shared-feature" }),
            makeThread("inactive-two", { branch: "shared-feature" }),
            makeThread("pending-approval", {
              branch: "protected-feature",
              hasPendingApprovals: true,
            }),
          ],
          updatedAt: NOW,
        };
        const activation = yield* Deferred.make<void>();
        const snapshotReads = yield* Queue.unbounded<void>();
        const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
        const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
        const branchCalls = yield* Ref.make<
          ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
        >([]);
        const settingsService = ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.fromPubSub(settingsChanges),
          subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
            Effect.map(Stream.fromSubscription),
          ),
        });
        const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
          if (command.type !== "thread.auto-settle") {
            return Effect.die(new Error(`Unexpected command: ${command.type}`));
          }
          return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
            Effect.as({ sequence: 1 }),
          );
        };
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () =>
              Queue.offer(snapshotReads, undefined).pipe(Effect.andThen(Effect.succeed(snapshot))),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            branchPullRequest: (input) =>
              Ref.update(branchCalls, (calls) => [...calls, input]).pipe(Effect.as(null)),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () => Effect.die(new Error("No linked merge request expected.")),
          }),
          Layer.mock(OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch,
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
          Layer.succeed(ServerSettingsService, settingsService),
          Layer.succeed(ServerActivation, Deferred.await(activation)),
          Layer.succeed(Crypto.Crypto, testCrypto),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          assert.deepStrictEqual(yield* Ref.get(commands), []);

          yield* Deferred.succeed(activation, undefined);
          yield* Queue.take(snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(commands))
              .map(({ threadId, snapshotSequence }) => ({ threadId, snapshotSequence }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              { threadId: ThreadId.make("inactive-one"), snapshotSequence: 7 },
              { threadId: ThreadId.make("inactive-two"), snapshotSequence: 7 },
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(branchCalls), [
            { cwd: "/workspace/project", branch: "shared-feature" },
          ]);
        }).pipe(Effect.provide(ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
  );
});
