import { expect, it } from "vite-plus/test";

import { keybindingWhenExpressionsOverlap } from "./keybindingOverlap";

it("detects logically overlapping shortcut contexts", () => {
  expect(keybindingWhenExpressionsOverlap("projectOpen", "projectOpen && !terminalFocus")).toBe(
    true,
  );
  expect(keybindingWhenExpressionsOverlap("terminalFocus", "!terminalFocus")).toBe(false);
  expect(keybindingWhenExpressionsOverlap("", "fileOpen")).toBe(true);
});
