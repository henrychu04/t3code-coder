import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN attachments_json TEXT`;
  // Earlier Coder projections omitted attachment metadata, but turn intent retained it.
  // Recover only existing message metadata; attachment bytes remain in the workspace.
  yield* sql`
    WITH attachment_events AS (
      SELECT stream_id AS thread_id,
        json_extract(payload_json, '$.messageId') AS message_id,
        json_extract(payload_json, '$.attachments') AS attachments,
        ROW_NUMBER() OVER (
          PARTITION BY stream_id, json_extract(payload_json, '$.messageId')
          ORDER BY sequence DESC
        ) AS rank
      FROM orchestration_events
      WHERE event_type IN ('thread.message-sent', 'thread.turn-start-requested')
        AND json_type(payload_json, '$.attachments') = 'array'
    )
    UPDATE projection_thread_messages AS message
    SET attachments_json = event.attachments
    FROM attachment_events AS event
    WHERE event.rank = 1 AND message.message_id = event.message_id
      AND message.thread_id = event.thread_id
  `;
});
