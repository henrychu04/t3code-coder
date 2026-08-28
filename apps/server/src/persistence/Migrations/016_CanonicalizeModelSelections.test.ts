import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("016_CanonicalizeModelSelections", (it) => {
  it.effect("advances the fresh Coder database to canonical model-selection columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 16 });

      const projectColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;

      assert.isTrue(projectColumns.some(({ name }) => name === "default_model_selection_json"));
      assert.isFalse(projectColumns.some(({ name }) => name === "default_model"));
      assert.isTrue(threadColumns.some(({ name }) => name === "model_selection_json"));
      assert.isFalse(threadColumns.some(({ name }) => name === "model"));
    }),
  );
});
