import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runLegacyMigrations } from "./CoderMigrationHistory.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const inFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ type: string; name: string; tbl_name: string }>`
    SELECT type, name, tbl_name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name != 'effect_sql_migrations'
    ORDER BY type, name
  `;
  const columns: Record<string, unknown> = {};
  for (const object of objects.filter((entry) => entry.type === "table")) {
    const info = yield* sql<{ name: string; type: string; notnull: number; dflt_value: unknown }>`
      SELECT name, type, "notnull", dflt_value FROM pragma_table_info(${object.name})
    `;
    columns[object.name] = [...info].sort((a, b) => a.name.localeCompare(b.name));
  }
  return { objects, columns };
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [Number(row.migration_id), row.name] as const);
});

const upstreamSchema = inFreshDatabase(Effect.andThen(runMigrations(), schema));

it.effect("leaves a fresh database on upstream's migration IDs", () =>
  inFreshDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  ),
);

for (const throughId of [undefined, 49, 40]) {
  it.effect(`adopts upstream IDs after the legacy registry through ${throughId ?? "58"}`, () =>
    Effect.gen(function* () {
      const expected = yield* upstreamSchema;
      yield* inFreshDatabase(
        Effect.gen(function* () {
          yield* runLegacyMigrations(migrationEntries, throughId);
          assert.deepStrictEqual(yield* runMigrations(), []);
          assert.deepStrictEqual(yield* history, migrationManifest);
          assert.deepStrictEqual(yield* schema, expected);
          assert.deepStrictEqual(yield* runMigrations(), []);
        }),
      );
    }),
  );
}

it.effect("refuses an unrecognized migration history", () =>
  inFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 10 });
      yield* sql`UPDATE effect_sql_migrations SET name = 'Unknown' WHERE migration_id = 10`;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
    }),
  ),
);
