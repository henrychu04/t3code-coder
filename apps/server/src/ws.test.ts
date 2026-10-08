import { assert, it } from "@effect/vitest";

import { exceedsHelperStdioFrame, shouldUseBoundedThreadSnapshot } from "./ws.ts";

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it("Coder: rejects snapshots that cannot fit one helper stdio frame", () => {
  assert.isFalse(exceedsHelperStdioFrame({ text: "x".repeat(1024) }));
  assert.isTrue(exceedsHelperStdioFrame({ text: "x".repeat(8 * 1024 * 1024) }));
});
