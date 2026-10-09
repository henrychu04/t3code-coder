/**
 * Coder: upgrade databases created before T3 Coder adopted upstream's migration IDs.
 *
 * Those databases recorded a renumbered registry: no upstream migration 7 or auth
 * migrations, upstream 43–54 under IDs 41–58, and two Coder-only migrations.
 * Effect's migrator only runs IDs above the latest recorded one, so upstream
 * migrations that reuse those IDs would be skipped silently. Such a database first
 * finishes the old registry, whose final schema matches upstream ID 54, and then
 * has its history rewritten to upstream's IDs.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import RepairPendingUserInputCounts from "./Migrations/CoderLegacy/050_RepairPendingUserInputCounts.ts";
import ProjectionMessageAttachments from "./Migrations/CoderLegacy/055_ProjectionMessageAttachments.ts";

type MigrationEntry = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<void, unknown, SqlClient.SqlClient>,
];

/** Upstream IDs the old registry omitted. */
const LEGACY_OMITTED_IDS = new Set([7, 20, 21, 22, 31, 32]);
const LEGACY_SHARED_THROUGH_ID = 40;
const LEGACY_RENUMBERED = [
  [41, "ProjectionThreadsUnsettledAt"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectsAutoPull"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "RepairPendingUserInputCounts"],
  [51, "ProjectionThreadPullRequests"],
  [52, "ProjectionProjectIcon"],
  [53, "ProjectionThreadTitleState"],
  [54, "PullRequestFilesViewed"],
  [55, "ProjectionMessageAttachments"],
  [56, "ProjectionThreadMessageContext"],
  [57, "ProjectionThreadsAutoSettleDisabledAt"],
  [58, "ClearAutomaticProjectModelDefaults"],
] as const;
/** The completed old registry has the same schema as upstream through this ID. */
const LEGACY_EQUIVALENT_UPSTREAM_ID = 54;

const coderOnlyMigrations: Record<string, MigrationEntry[2]> = {
  RepairPendingUserInputCounts,
  ProjectionMessageAttachments,
};

const legacyMigrationEntries = (
  upstream: ReadonlyArray<MigrationEntry>,
): ReadonlyArray<MigrationEntry> => {
  const byName = new Map(upstream.map(([, name, migration]) => [name, migration]));
  const resolve = (name: string) => {
    const migration = coderOnlyMigrations[name] ?? byName.get(name);
    if (migration === undefined) throw new Error(`Missing legacy migration ${name}`);
    return migration;
  };
  return [
    ...upstream.filter(([id]) => id <= LEGACY_SHARED_THROUGH_ID && !LEGACY_OMITTED_IDS.has(id)),
    ...LEGACY_RENUMBERED.map(([id, name]): MigrationEntry => [id, name, resolve(name)]),
  ];
};

const run = Migrator.make({});

export const runLegacyMigrations = (upstream: ReadonlyArray<MigrationEntry>, throughId?: number) =>
  run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        legacyMigrationEntries(upstream)
          .filter(([id]) => throughId === undefined || id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });

interface AppliedMigration {
  readonly migration_id: number;
  readonly name: string;
}

/** Applied rows are exactly the registry's entries up to the latest applied ID. */
const isHistoryOf = (
  applied: ReadonlyArray<AppliedMigration>,
  registry: ReadonlyArray<readonly [number, string, ...unknown[]]>,
) => {
  const latest = applied.reduce((max, row) => Math.max(max, Number(row.migration_id)), 0);
  const expected = registry.filter(([id]) => id <= latest);
  const names = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  return (
    applied.length === expected.length && expected.every(([id, name]) => names.get(id) === name)
  );
};

export const reconcileCoderMigrationHistory = Effect.fn("reconcileCoderMigrationHistory")(
  function* (upstream: ReadonlyArray<MigrationEntry>) {
    const sql = yield* SqlClient.SqlClient;
    const table = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (table.length === 0) return false;
    const applied = yield* sql<AppliedMigration>`
      SELECT migration_id, name FROM effect_sql_migrations
    `;
    if (isHistoryOf(applied, upstream)) return false;
    if (!isHistoryOf(applied, legacyMigrationEntries(upstream))) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: "Unrecognized migration history",
      });
    }

    yield* runLegacyMigrations(upstream);
    const rows = upstream
      .filter(([id]) => id <= LEGACY_EQUIVALENT_UPSTREAM_ID)
      .map(([migration_id, name]) => ({ migration_id, name }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM effect_sql_migrations`;
        yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(rows)}`;
      }),
    );
    yield* Effect.log("Adopted upstream migration IDs");
    return true;
  },
);
