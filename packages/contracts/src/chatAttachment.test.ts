import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  SnapShotAccessibility,
} from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

// The tolerant member must not catch malformed known attachments: a file over
// the size cap or an image with a bad mime has to fail its own schema, not
// slide through the open one with those constraints unchecked.
it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

it("Coder: rejects GIF composer images", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/gif"), false);
});

it("Coder: decodes earlier pasted images as legacy image attachments", () => {
  const decode = Schema.decodeUnknownSync(ChatAttachment);
  const id = "11111111-1111-4111-8111-111111111111.png";
  assert.deepEqual(decode({ type: "image", id }), {
    type: "image",
    id: "legacy-11111111-1111-4111-8111-111111111111-png",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 0,
  });
  assert.deepEqual(decode({ type: "image", id, name: "checkout.png" }).name, "checkout.png");
  assert.throws(() => decode({ type: "image", id: "../checkout.png", name: "checkout.png" }));
  assert.throws(() => decode({ type: "image", id, name: "x".repeat(256) }));
  const current = {
    type: "image",
    id: "pending-11111111-1111-4111-8111-111111111111-png",
    name: "checkout.png",
    mimeType: "image/png",
    sizeBytes: 12,
  };
  assert.deepEqual(decode(current), current);
});
