import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
layer("message attachment migration", (it) => {
  it.effect("recovers legacy intent metadata without changing text or unnamed messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const attachments = [
        { type: "image", id: "00000000-0000-4000-8000-000000000001.png", name: "diagram.png" },
      ];
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('named', 'thread', 'user', 'keep text', 0, '2026-01-01', '2026-01-01'), ('legacy', 'thread', 'user', 'legacy text', 0, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES ('event', 'thread', 'thread', 1, 'thread.turn-start-requested', '2026-01-01', 'user', ${JSON.stringify({ threadId: "thread", messageId: "named", attachments })}, '{}')`;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const rows = yield* sql<{
        message_id: string;
        text: string;
        attachments_json: string | null;
      }>`SELECT message_id, text, attachments_json FROM projection_thread_messages ORDER BY message_id`;
      assert.deepStrictEqual(rows, [
        { message_id: "legacy", text: "legacy text", attachments_json: null },
        { message_id: "named", text: "keep text", attachments_json: JSON.stringify(attachments) },
      ]);
    }),
  );
});
