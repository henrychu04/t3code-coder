import { assert, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as LegacyScreenshotArtifacts from "./LegacyScreenshotArtifacts.ts";

const TestLayer = LegacyScreenshotArtifacts.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const artifact = (id: string) => ({
  id: `0000000${id}-0000-4000-8000-000000000000`,
  name: `screenshot-${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
    VALUES ('thread-legacy', '2026-01-01', '2026-01-01')
  `;
  const message = (id: string, threadId: string, role: string, createdAt: string) => sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (${id}, ${threadId}, NULL, ${role}, 'text', 0, ${createdAt}, ${createdAt})
  `;
  yield* message("message-user", "thread-legacy", "user", "2026-01-01T00:00:00.000Z");
  yield* message("message-reply", "thread-legacy", "assistant", "2026-01-01T00:05:00.000Z");
  yield* message("message-v2-only", "thread-not-imported", "user", "2026-01-01T00:00:00.000Z");
  const activity = (id: string, threadId: string, createdAt: string, payload: unknown) => sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      ${id}, ${threadId}, NULL, 'tool', 'tool.completed', 'Tool', ${JSON.stringify(payload)},
      ${createdAt}
    )
  `;
  // A tool's update and completion repeat the same screenshot.
  yield* activity("a1", "thread-legacy", "2026-01-01T00:01:00.000Z", {
    artifacts: [artifact("1")],
  });
  yield* activity("a2", "thread-legacy", "2026-01-01T00:02:00.000Z", {
    artifacts: [artifact("1"), artifact("2"), { id: "not-an-artifact" }],
  });
  yield* activity("a3", "thread-legacy", "2026-01-01T00:03:00.000Z", { detail: "no images" });
  yield* activity("a4", "thread-legacy", "2026-01-01T00:06:00.000Z", {
    artifacts: [artifact("3")],
  });
  yield* activity("a5", "thread-not-imported", "2026-01-01T00:01:00.000Z", {
    artifacts: [artifact("4")],
  });
});

it.layer(TestLayer)("LegacyScreenshotArtifacts", (it) => {
  it.effect("returns screenshots taken between an imported message and the next", () =>
    Effect.gen(function* () {
      yield* seed;
      const legacy = yield* LegacyScreenshotArtifacts.LegacyScreenshotArtifacts;
      const ids = (messageId: string) =>
        legacy
          .listAfterMessage(MessageId.make(messageId))
          .pipe(Effect.map(({ artifacts }) => artifacts.map((entry) => entry.name)));

      assert.deepStrictEqual(yield* ids("message-user"), ["screenshot-1.png", "screenshot-2.png"]);
      assert.deepStrictEqual(yield* ids("message-reply"), ["screenshot-3.png"]);
      // Threads that were not imported from v1 never surface v1 rows.
      assert.deepStrictEqual(yield* ids("message-v2-only"), []);
      assert.deepStrictEqual(yield* ids("message-missing"), []);
    }),
  );
});
