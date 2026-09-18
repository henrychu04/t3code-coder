import { SCRIPT_RUN_COMMAND_PATTERN, type KeybindingCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectScript } from "@t3tools/contracts";
import type { NewProjectScriptInput } from "./components/projectScriptEditor";
const MAX_SCRIPT_ID_LENGTH = 64;
export function buildProjectScript(id: string, input: NewProjectScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
  };
}
function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);
export function commandForProjectScript(id: string): KeybindingCommand | null {
  const command = `script.${id}.run`;
  return isScriptRunCommand(command) ? command : null;
}
export function projectScriptIdFromCommand(command: string): string | null {
  return isScriptRunCommand(command) ? command.slice(7, -4) : null;
}
