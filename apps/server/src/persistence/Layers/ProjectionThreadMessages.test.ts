import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("persists structured context and keeps it across updates without context", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-context");
      const messageId = MessageId.make("message-context");
      const createdAt = "2026-02-28T19:05:00.000Z";
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: "ctx_1" as never,
            kind: "terminal" as const,
            label: "Terminal 1 line 4",
            terminalId: "default",
            terminalLabel: "Terminal 1",
            lineStart: 4,
            lineEnd: 4,
            text: "boom",
          },
        ],
      };
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx_1)",
        context,
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx_1)",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:05:01.000Z",
      });
      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(rows[0]?.context, context);
    }),
  );
});
