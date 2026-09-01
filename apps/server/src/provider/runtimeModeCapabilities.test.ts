import { assert, it } from "@effect/vitest";

import {
  attachSupportedRuntimeModes,
  buildSupportedRuntimeModes,
} from "./runtimeModeCapabilities.ts";

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

it("attaches runtime modes without dropping model-specific capabilities", () => {
  const [model] = attachSupportedRuntimeModes(
    [
      {
        slug: "test-model",
        name: "Test model",
        isCustom: true,
        capabilities: {
          optionDescriptors: [{ id: "fast", label: "Fast", type: "boolean" }],
        },
      },
    ],
    ["approval-required"],
  );

  assert.deepStrictEqual(model?.capabilities, {
    optionDescriptors: [{ id: "fast", label: "Fast", type: "boolean" }],
    supportedRuntimeModes: ["approval-required"],
  });
});
