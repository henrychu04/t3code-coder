import { describe, it, expect } from "vite-plus/test";
import {
  buildProjectScript,
  commandForProjectScript,
  projectScriptIdFromCommand,
} from "./projectScripts";
import { KEYBINDING_ACTIONS } from "./keybindingCatalog";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
describe("project-action shortcuts", () => {
  it("round trips valid script IDs", () => {
    expect(commandForProjectScript("test-1")).toBe("script.test-1.run");
    expect(projectScriptIdFromCommand("script.test-1.run")).toBe("test-1");
  });
  it.each(["", "../test", "a;exit", "a b", "A", "x".repeat(65)])(
    "rejects unsafe or legacy IDs %s",
    (id) => expect(commandForProjectScript(id)).toBeNull(),
  );
  it("does not treat static commands as scripts", () =>
    expect(projectScriptIdFromCommand("thread.stop")).toBeNull());
  it("exposes every supported static command exactly once", () => {
    expect(KEYBINDING_ACTIONS.map((a) => a.command).sort()).toEqual(
      [...STATIC_KEYBINDING_COMMANDS].sort(),
    );
  });
});

it("keeps setup asynchronous unless the user selects wait for completion", () => {
  const input = {
    name: "Setup",
    command: "pnpm install",
    icon: "build" as const,
    runOnWorktreeCreate: true,
    waitForSetup: false,
  };
  expect(buildProjectScript("setup", input).async).toBeUndefined();
  expect(buildProjectScript("setup", { ...input, waitForSetup: true }).async).toBe(false);
  expect(
    buildProjectScript("setup", { ...input, runOnWorktreeCreate: false, waitForSetup: true }).async,
  ).toBeUndefined();
});
