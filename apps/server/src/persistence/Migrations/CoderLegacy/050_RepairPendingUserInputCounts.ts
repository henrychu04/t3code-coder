import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Request IDs are unique: terminal activities win regardless of clock or provider sequence.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH request_states AS (
      SELECT thread_id, json_extract(payload_json, '$.requestId') AS request_id,
        MAX(kind = 'user-input.requested') AS requested,
        MAX(
          kind = 'user-input.resolved' OR (
            kind = 'provider.user-input.respond.failed' AND (
              lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
            )
          )
        ) AS closed
      FROM projection_thread_activities
      WHERE kind IN ('user-input.requested', 'user-input.resolved', 'provider.user-input.respond.failed')
        AND json_type(payload_json, '$.requestId') = 'text'
        AND length(trim(json_extract(payload_json, '$.requestId'))) > 0
      GROUP BY thread_id, request_id
    ), pending_counts AS (
      SELECT thread_id, COUNT(*) AS count
      FROM request_states WHERE requested = 1 AND closed = 0
      GROUP BY thread_id
    )
    UPDATE projection_threads
    SET pending_user_input_count = COALESCE((
      SELECT count FROM pending_counts WHERE pending_counts.thread_id = projection_threads.thread_id
    ), 0)
  `;
});
