/**
 * Coder: screenshots that pre-v2 conversations saved as `artifacts` on v1 tool activities.
 *
 * The v2 database starts as a copy of the v1 database, so the v1 `projection_thread_activities`
 * rows stay beside the imported conversation. Upstream's importer carries only messages, so this
 * read-only lookup returns the screenshots taken between one imported message and the next.
 * Nothing is written, which covers workspaces that migrated before this lookup existed.
 *
 * @module orchestration-v2/legacy/LegacyScreenshotArtifacts
 */
import {
  type LegacyScreenshotArtifactsResult,
  MAX_LEGACY_SCREENSHOT_ARTIFACTS_PER_MESSAGE,
  type MessageId,
  ScreenshotArtifactReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeArtifacts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeArtifact = Schema.decodeUnknownOption(ScreenshotArtifactReference);

export class LegacyScreenshotArtifacts extends Context.Service<
  LegacyScreenshotArtifacts,
  {
    readonly listAfterMessage: (
      messageId: MessageId,
    ) => Effect.Effect<LegacyScreenshotArtifactsResult>;
  }
>()("t3/orchestration-v2/legacy/LegacyScreenshotArtifacts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listAfterMessage = (messageId: MessageId) =>
    sql<{ readonly artifacts_json: string }>`
      WITH anchor AS (
        SELECT message.thread_id, message.created_at, message.message_id
        FROM projection_thread_messages AS message
        INNER JOIN orchestration_v2_legacy_imports AS legacy_import
          ON legacy_import.thread_id = message.thread_id
        WHERE message.message_id = ${messageId}
          AND message.role IN ('user', 'assistant')
      ),
      next AS (
        SELECT MIN(later.created_at) AS created_at
        FROM projection_thread_messages AS later, anchor
        WHERE later.thread_id = anchor.thread_id
          AND later.role IN ('user', 'assistant')
          AND (
            later.created_at > anchor.created_at
            OR (later.created_at = anchor.created_at AND later.message_id > anchor.message_id)
          )
      )
      SELECT json_extract(activity.payload_json, '$.artifacts') AS artifacts_json
      FROM projection_thread_activities AS activity, anchor, next
      WHERE activity.thread_id = anchor.thread_id
        AND activity.created_at >= anchor.created_at
        AND (next.created_at IS NULL OR activity.created_at < next.created_at)
        AND json_type(activity.payload_json, '$.artifacts') = 'array'
      ORDER BY activity.created_at ASC, activity.activity_id ASC
    `.pipe(
      Effect.map((rows) => {
        // A tool's update and completion activities repeat the same screenshots.
        const artifacts = new Map<string, ScreenshotArtifactReference>();
        for (const row of rows) {
          for (const value of Option.getOrElse(decodeArtifacts(row.artifacts_json), () => [])) {
            const artifact = decodeArtifact(value);
            if (Option.isSome(artifact) && !artifacts.has(artifact.value.id)) {
              artifacts.set(artifact.value.id, artifact.value);
            }
          }
        }
        return {
          artifacts: [...artifacts.values()].slice(0, MAX_LEGACY_SCREENSHOT_ARTIFACTS_PER_MESSAGE),
        };
      }),
      // Legacy previews are best effort: an unreadable v1 row shows no screenshots.
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to read legacy screenshot artifacts", { cause }).pipe(
          Effect.as({ artifacts: [] }),
        ),
      ),
    );

  return LegacyScreenshotArtifacts.of({ listAfterMessage });
});

export const layer = Layer.effect(LegacyScreenshotArtifacts, make);
