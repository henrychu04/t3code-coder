import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { compensateFailedBootstrap, projectShellEvent } from "./coderWs.ts";

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
});
