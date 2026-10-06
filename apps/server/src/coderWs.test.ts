import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationThreadDetailSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { getProjectedThreadSnapshotWithinBudget } from "./coderWs.ts";

describe("Coder WebSocket boundary", () => {
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
  it.effect.each([false, true])(
    "projects reasoning messages according to the caller (%s)",
    (reasoningMessages) =>
      Effect.gen(function* () {
        const result = yield* getProjectedThreadSnapshotWithinBudget(
          {
            getThreadDetailSnapshot: () =>
              Effect.succeed(
                Option.some({
                  snapshotSequence: 1,
                  thread: { activities: [], messages: [{ role: "reasoning", text: "thinking" }] },
                } as unknown as OrchestrationThreadDetailSnapshot),
              ),
          },
          {
            threadId: ThreadId.make("reasoning"),
            turnLimit: 1,
            targetBytes: 1024,
            reasoningMessages,
          },
        );
        expect(Option.getOrThrow(result).thread.messages[0]?.role).toBe(
          reasoningMessages ? "reasoning" : "system",
        );
      }),
  );
  it.effect("rejects a newest turn that cannot fit the stdio frame", () =>
    Effect.gen(function* () {
      const result = yield* getProjectedThreadSnapshotWithinBudget(
        {
          getThreadDetailSnapshot: () =>
            Effect.succeed(
              Option.some({
                snapshotSequence: 1,
                thread: { activities: [], messages: [{ text: "x".repeat(8 * 1024 * 1024) }] },
              } as unknown as OrchestrationThreadDetailSnapshot),
            ),
        },
        { threadId: ThreadId.make("oversized"), turnLimit: 1, targetBytes: 4 * 1024 * 1024 },
      ).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationGetSnapshotError");
    }),
  );
});
