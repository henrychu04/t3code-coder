import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

import { ProviderSendTurnInput, ProviderUploadFeedbackError } from "./provider.ts";

const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSendTurnInput", () => {
  it.each(["image", "file"])(
    "caps total image bytes for %s attachments without charging videos",
    (type) => {
      const image = {
        type,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      };
      const video = {
        type: "file",
        id: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50 * 1024 * 1024,
      };
      expect(
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), video],
        }).attachments,
      ).toHaveLength(9);
      expect(() =>
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
        }),
      ).toThrow(/80 MiB/);
    },
  );

  it("decodes Coder's earlier pasted-image ids and rejects path-shaped ones", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      attachments: [{ type: "image", id: "550e8400-e29b-41d4-a716-446655440000.png" }],
    });
    expect(parsed.attachments?.[0]?.id).toBe("legacy-550e8400-e29b-41d4-a716-446655440000-png");
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        attachments: [{ type: "image", id: "../550e8400-e29b-41d4-a716-446655440000.png" }],
      }),
    ).toThrow();
  });
});

describe("provider feedback", () => {
  it("keeps the failed thread and original cause without exposing upstream text", () => {
    const cause = new Error("provider request secret");
    const error = new ProviderUploadFeedbackError({
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error.threadId).toBe("thread-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Failed to upload feedback for thread thread-1.");
    expect(error.message).not.toContain("provider request secret");
  });
});
