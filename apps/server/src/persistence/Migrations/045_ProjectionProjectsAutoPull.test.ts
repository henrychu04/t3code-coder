import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("045_ProjectionProjectsAutoPull", (it) => {
  it.effect("adds auto_pull to projection_projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isFalse(before.some((column) => column.name === "auto_pull"));

      yield* runMigrations({ toMigrationInclusive: 45 });
      const after = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const autoPull = after.find((column) => column.name === "auto_pull");
      assert.equal(autoPull?.name, "auto_pull");
      assert.equal(autoPull?.notnull, 1);
    }),
  );
});
