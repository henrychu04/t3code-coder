import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as Path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS = 100_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Recover only a complete, linear main-session transcript whose completed turns
 * exactly match our cursor. Compaction, branching, steering and missing messages
 * cannot establish the old orchestration-to-provider mapping, so fail closed.
 */
export function recoverClaudeTurnBoundaries(input: {
  transcript: string;
  sessionId: string;
  cwd: string;
  knownBoundaries: readonly (string | null)[];
}): readonly string[] | null {
  if (!UUID.test(input.sessionId) || !input.transcript.endsWith("\n")) return null;
  const lines = input.transcript.split("\n");
  if (lines.length > MAX_TRANSCRIPT_RECORDS) return null;
  const boundaries: string[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  let working = false;
  try {
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = record(JSON.parse(line));
      if (!entry) return null;
      if (entry.type === "summary" || entry.subtype === "compact_boundary" || entry.compactMetadata)
        return null;
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (
        entry.isSidechain === true ||
        entry.parent_tool_use_id != null ||
        entry.parent_agent_id != null
      )
        return null;
      if (entry.sessionId !== input.sessionId || entry.cwd !== input.cwd) return null;
      if (
        typeof entry.uuid !== "string" ||
        !UUID.test(entry.uuid) ||
        seen.has(entry.uuid) ||
        entry.parentUuid !== previous
      )
        return null;
      seen.add(entry.uuid);
      previous = entry.uuid;
      const message = record(entry.message);
      if (!message || message.role !== entry.type) return null;
      const content = message.content;
      if (entry.type === "user") {
        const toolResult =
          Array.isArray(content) &&
          content.length > 0 &&
          content.every((part) => record(part)?.type === "tool_result");
        if (toolResult) {
          if (!working) return null;
        } else {
          if (working || !(typeof content === "string" || Array.isArray(content))) return null;
          working = true;
        }
      } else {
        if (!working) return null;
        if (message.stop_reason === "end_turn") {
          boundaries.push(entry.uuid);
          working = false;
        }
      }
    }
  } catch {
    return null;
  }
  if (working || boundaries.length !== input.knownBoundaries.length) return null;
  return input.knownBoundaries.every(
    (known, index) => known === null || known === boundaries[index],
  )
    ? boundaries
    : null;
}

/**
 * Read only this session in this project's workspace-owned Claude configuration.
 * No project/home scan, transcript mutation, credential access, or new RPC surface.
 * CLI storage: https://code.claude.com/docs/en/sessions#where-transcripts-are-stored
 */
export async function readClaudeRewindHistory(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
  knownBoundaries: readonly (string | null)[];
}): Promise<readonly string[] | null> {
  if (!UUID.test(input.sessionId) || !Path.isAbsolute(input.cwd)) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const configDir = await realpath(input.configDir);
    const projectDir = Path.join(configDir, "projects", input.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    // Do not follow a projects directory, project directory, or transcript out of this exact location.
    if ((await realpath(projectDir)) !== projectDir) return null;
    file = await open(
      Path.join(projectDir, `${input.sessionId}.jsonl`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_TRANSCRIPT_BYTES) return null;
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      return null;
    return recoverClaudeTurnBoundaries({
      ...input,
      transcript: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)),
    });
  } catch {
    // Paths and transcript contents never enter diagnostics or user-visible errors.
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
