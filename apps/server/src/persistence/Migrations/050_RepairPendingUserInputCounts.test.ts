import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import repairCounts from "./050_RepairPendingUserInputCounts.ts";

it.layer(NodeSqliteClient.layerMemory())("050_RepairPendingUserInputCounts", (it) => {
  it.effect(
    "repairs clock-skewed counts while preserving open questions and activity history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        for (const threadId of ["closed", "open", "empty"]) {
          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            created_at, updated_at, pending_user_input_count
          ) VALUES (${threadId}, 'project', 'Thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 9)
        `;
        }
        const cases = [
          ["closed", "resolved", "user-input.resolved", ""],
          [
            "closed",
            "stale",
            "provider.user-input.respond.failed",
            "Unknown pending codex user input request",
          ],
          ["open", "pending", "provider.user-input.respond.failed", "Temporary connection error"],
        ];
        for (const [threadId, requestId, kind, detail] of cases) {
          for (const closed of [false, true]) {
            yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
            ) VALUES (
              ${`${requestId}-${closed}`}, ${threadId}, NULL, 'info',
              ${closed ? kind : "user-input.requested"}, 'Question',
              ${JSON.stringify({ requestId, detail })}, ${closed ? null : 999},
              ${closed ? "2026-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z"}
            )
          `;
          }
        }
        const before = yield* sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`;
        yield* runMigrations({ toMigrationInclusive: 50 });
        yield* repairCounts;
        const counts =
          yield* sql`SELECT thread_id, pending_user_input_count FROM projection_threads ORDER BY thread_id`;
        assert.deepEqual(counts, [
          { thread_id: "closed", pending_user_input_count: 0 },
          { thread_id: "empty", pending_user_input_count: 0 },
          { thread_id: "open", pending_user_input_count: 1 },
        ]);
        assert.deepEqual(
          yield* sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`,
          before,
        );
      }),
  );
});
