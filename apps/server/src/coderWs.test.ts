import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationEvent, OrchestrationThreadDetailSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  compensateFailedBootstrap,
  getProjectedThreadSnapshotWithinBudget,
  isShellMaterialEvent,
  projectLiveShellEvents,
  projectShellEvent,
} from "./coderWs.ts";

describe("Coder WebSocket boundary", () => {
  it.effect("removes a created worktree before deleting a failed bootstrap thread", () =>
    Effect.gen(function* () {
      const compensationOrder: string[] = [];

      yield* compensateFailedBootstrap({
        worktree: { cwd: "/repo", path: "/repo-worktree" },
        removeWorktree: () =>
          Effect.sync(() => compensationOrder.push("worktree")).pipe(
            Effect.andThen(Effect.fail(new Error("best-effort removal failed"))),
          ),
        deleteThread: Effect.sync(() => compensationOrder.push("thread")),
      });

      expect(compensationOrder).toEqual(["worktree", "thread"]);
    }),
  );

  it.effect("fails a shell projection lookup instead of fabricating entity removal", () =>
    Effect.gen(function* () {
      const event = {
        type: "project.updated",
        aggregateKind: "project",
        aggregateId: "project-one",
        sequence: 42,
        payload: {},
      } as unknown as OrchestrationEvent;
      const failure = yield* projectShellEvent(event, {
        getProjectShellById: () => Effect.fail(new Error("sqlite busy")),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }).pipe(Effect.flip);

      expect(failure._tag).toBe("OrchestrationGetSnapshotError");
      expect(failure.message).toContain("project-one");
    }),
  );

  it("skips known immaterial activity and assistant deltas but fails open", () => {
    const activity = (kind: string) =>
      ({
        type: "thread.activity-appended",
        aggregateKind: "thread",
        payload: { activity: { kind } },
      }) as unknown as OrchestrationEvent;
    const message = (role: "user" | "assistant", streaming: boolean) =>
      ({
        type: "thread.message-sent",
        aggregateKind: "thread",
        payload: { role, streaming },
      }) as unknown as OrchestrationEvent;

    expect(isShellMaterialEvent(activity("tool.updated"))).toBe(false);
    expect(isShellMaterialEvent(activity("tool.progress"))).toBe(false);
    expect(isShellMaterialEvent(activity("context-window.updated"))).toBe(false);
    expect(isShellMaterialEvent(message("assistant", true))).toBe(false);
    expect(isShellMaterialEvent(activity("approval.requested"))).toBe(true);
    expect(isShellMaterialEvent(activity("task.progress"))).toBe(true);
    expect(isShellMaterialEvent(activity("future.sidebar-relevant"))).toBe(true);
    expect(isShellMaterialEvent(message("assistant", false))).toBe(true);
    expect(isShellMaterialEvent(message("user", false))).toBe(true);
  });

  it.effect("coalesces immaterial shell events into bounded cursor watermarks", () =>
    Effect.gen(function* () {
      const events = Array.from({ length: 250 }, (_, index) => ({
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-one",
        sequence: index + 1,
        payload: { activity: { kind: "tool.progress" } },
      })) as unknown as ReadonlyArray<OrchestrationEvent>;

      const items = yield* projectLiveShellEvents(Stream.fromIterable(events), 0, {
        getProjectShellById: () => Effect.die("project lookup should not run"),
        getThreadShellById: () => Effect.die("thread lookup should not run"),
      }).pipe(Stream.runCollect);

      expect(items).toEqual([{ kind: "cursor", sequence: 250 }]);
    }),
  );

  it.effect("selects the largest recent-turn window within the snapshot byte target", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly turnLimit?: number; readonly beforeCursor?: string }> = [];
      const makeSnapshot = (turnLimit: number) =>
        ({
          snapshotSequence: turnLimit,
          thread: {
            activities: [],
            messages: [{ text: "x".repeat(turnLimit * 100) }],
            proposedPlans: [],
            checkpoints: [],
          },
          page: {
            beforeCursor: "next",
            hasMore: true,
            snapshotSequence: turnLimit,
          },
        }) as unknown as OrchestrationThreadDetailSnapshot;
      const targetBytes = Buffer.byteLength(JSON.stringify(makeSnapshot(4)), "utf8");

      const result = yield* getProjectedThreadSnapshotWithinBudget(
        {
          getThreadDetailSnapshot: (_threadId, window) =>
            Effect.sync(() => {
              calls.push(window ?? {});
              return Option.some(makeSnapshot(window?.turnLimit ?? 0));
            }),
        },
        {
          threadId: "thread-one" as never,
          turnLimit: 8,
          beforeCursor: "older-page",
          targetBytes,
        },
      );

      expect(Option.getOrThrow(result).snapshotSequence).toBe(4);
      expect(calls[0]).toEqual({ turnLimit: 8, beforeCursor: "older-page" });
      expect(calls.every((call) => call.beforeCursor === "older-page")).toBe(true);
    }),
  );

  it.effect("retains one turn when a single turn exceeds the snapshot byte target", () =>
    Effect.gen(function* () {
      const result = yield* getProjectedThreadSnapshotWithinBudget(
        {
          getThreadDetailSnapshot: (_threadId, window) =>
            Effect.succeed(
              Option.some({
                snapshotSequence: window?.turnLimit ?? 0,
                thread: {
                  activities: [],
                  messages: [{ text: "large".repeat(1_000) }],
                  proposedPlans: [],
                  checkpoints: [],
                },
              } as unknown as OrchestrationThreadDetailSnapshot),
            ),
        },
        {
          threadId: "thread-one" as never,
          turnLimit: 5,
          targetBytes: 1,
        },
      );

      expect(Option.getOrThrow(result).snapshotSequence).toBe(1);
    }),
  );
});
