import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import clearAutomaticDefaults from "./058_ClearAutomaticProjectModelDefaults.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "058_ClearAutomaticProjectModelDefaults",
  (it) => {
    it.effect(
      "clears automatic seeds in projections and events and preserves explicit defaults",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 57 });
          const now = "2026-01-01T00:00:00.000Z";
          const selection = { instanceId: "codex", model: "gpt-5.4" };
          const cases = ["automatic", "explicit", "reset", "unrelated-meta", "null", "absent"];
          for (const id of cases) {
            const initial = id === "null" || id === "absent" ? null : selection;
            const projected = id === "reset" ? null : initial;
            yield* sql`
            INSERT INTO projection_projects (
              project_id, title, workspace_root, default_model_selection_json,
              scripts_json, created_at, updated_at
            ) VALUES (${id}, ${id}, ${`/workspace/${id}`},
              ${projected === null ? null : JSON.stringify(projected)}, '[]', ${now}, ${now})
          `;
            const payload = id === "absent" ? {} : { defaultModelSelection: initial };
            yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, actor_kind, payload_json, metadata_json
            ) VALUES (${`${id}-created`}, 'project', ${id}, 1, 'project.created',
              ${now}, 'client', ${JSON.stringify(payload)}, '{}')
          `;
            if (id === "explicit" || id === "reset" || id === "unrelated-meta") {
              const update =
                id === "unrelated-meta"
                  ? { title: "Renamed" }
                  : { defaultModelSelection: id === "reset" ? null : selection };
              yield* sql`
              INSERT INTO orchestration_events (
                event_id, aggregate_kind, stream_id, stream_version, event_type,
                occurred_at, actor_kind, payload_json, metadata_json
              ) VALUES (${`${id}-updated`}, 'project', ${id}, 2, 'project.meta-updated',
                ${now}, 'client', ${JSON.stringify(update)}, '{}')
            `;
            }
          }
          const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
          assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 58 }), [
            [58, "ClearAutomaticProjectModelDefaults"],
          ]);
          const rows = yield* sql<{
            project_id: string;
            default_model_selection_json: string | null;
          }>`
          SELECT project_id, default_model_selection_json FROM projection_projects ORDER BY project_id
        `;
          assert.deepEqual(
            rows,
            [...cases].sort().map((id) => ({
              project_id: id,
              default_model_selection_json: id === "explicit" ? JSON.stringify(selection) : null,
            })),
          );
          const after = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
          assert.deepEqual(
            after,
            before.map((row) =>
              row.event_type === "project.created" &&
              (row.stream_id === "automatic" || row.stream_id === "unrelated-meta")
                ? { ...row, payload_json: JSON.stringify({ defaultModelSelection: null }) }
                : row,
            ),
          );
          yield* clearAutomaticDefaults;
          assert.deepEqual(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`, after);
          assert.deepEqual(
            yield* sql`
          SELECT project_id, default_model_selection_json FROM projection_projects ORDER BY project_id
        `,
            rows,
          );
        }),
    );
  },
);
