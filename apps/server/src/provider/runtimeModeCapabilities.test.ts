import { assert, it } from "@effect/vitest";

import { buildSupportedRuntimeModes } from "./runtimeModeCapabilities.ts";

it("builds runtime modes in the shared UI order", () => {
  assert.deepStrictEqual(
    buildSupportedRuntimeModes({
      approvalRequired: false,
      autoAcceptEdits: true,
      auto: true,
      fullAccess: true,
    }),
    ["auto-accept-edits", "auto", "full-access"],
  );
});
