import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// T3 Coder owns a fresh ~/.t3-coder database namespace, so this historical
// migration only advances the schema; it does not import upstream provider data.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_model_selection_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN model_selection_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_projects
    DROP COLUMN default_model
  `;

  yield* sql`
    ALTER TABLE projection_threads
    DROP COLUMN model
  `;
});
