import { mkdtemp, mkdir, writeFile, rm, symlink, truncate, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readClaudeRewindHistory, recoverClaudeTurnBoundaries } from "./ClaudeRewindHistory.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440002";
const cwd = "/workspaces/test-project";
const id = (n: number) => `550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`;
const messages = [
  { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "First" } },
  {
    type: "assistant",
    uuid: id(2),
    parentUuid: id(1),
    message: { role: "assistant", content: [], stop_reason: "tool_use" },
  },
  {
    type: "user",
    uuid: id(3),
    parentUuid: id(2),
    message: { role: "user", content: [{ type: "tool_result", content: "Done" }] },
  },
  {
    type: "assistant",
    uuid: id(4),
    parentUuid: id(3),
    message: { role: "assistant", content: [], stop_reason: "end_turn" },
  },
  { type: "user", uuid: id(5), parentUuid: id(4), message: { role: "user", content: "Second" } },
  {
    type: "assistant",
    uuid: id(6),
    parentUuid: id(5),
    message: { role: "assistant", content: [], stop_reason: "end_turn" },
  },
].map((entry) => ({ ...entry, sessionId, cwd }));
const encode = (rows: readonly unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const input = { sessionId, cwd, knownBoundaries: [null, null] };

describe("legacy Claude rewind recovery", () => {
  it("recovers completed main turns without counting tool results as user turns", () => {
    expect(recoverClaudeTurnBoundaries({ ...input, transcript: encode(messages) })).toEqual([
      id(4),
      id(6),
    ]);
    expect(
      recoverClaudeTurnBoundaries({
        ...input,
        knownBoundaries: [id(4), null],
        transcript: encode(messages),
      }),
    ).toEqual([id(4), id(6)]);
  });
  it("rejects mismatched turn counts, known UUIDs, project roots, and sessions", () => {
    const transcript = encode(messages);
    for (const overrides of [
      { knownBoundaries: [null] },
      { knownBoundaries: [id(8), null] },
      { cwd: "/another" },
      { sessionId: id(9) },
    ]) {
      expect(recoverClaudeTurnBoundaries({ ...input, ...overrides, transcript })).toBeNull();
    }
  });
  it("rejects branched, compacted, duplicated, steered, subagent and truncated transcripts", () => {
    const variants = [
      encode([...messages, { ...messages[5], uuid: id(7) }]),
      encode([...messages, { type: "system", subtype: "compact_boundary" }]),
      encode([...messages, messages[5]]),
      encode([messages[0], { ...messages[4], parentUuid: id(1) }, ...messages.slice(1)]),
      encode(
        messages.map((entry, index) => (index === 1 ? { ...entry, isSidechain: true } : entry)),
      ),
      encode(messages).trimEnd(),
      encode(messages.slice(0, -1)),
      "{bad json}\n",
    ];
    for (const transcript of variants)
      expect(recoverClaudeTurnBoundaries({ ...input, transcript })).toBeNull();
  });
  it("reads only the bounded, non-symlink transcript at the exact configured location", async () => {
    const temp = await realpath(await mkdtemp(Path.join(tmpdir(), "t3-claude-rewind-")));
    try {
      const projectDir = Path.join(temp, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      await mkdir(projectDir, { recursive: true });
      const file = Path.join(projectDir, `${sessionId}.jsonl`);
      await writeFile(file, encode(messages));
      expect(await readClaudeRewindHistory({ ...input, configDir: temp })).toEqual([id(4), id(6)]);
      expect(
        await readClaudeRewindHistory({ ...input, configDir: temp, sessionId: "../secret" }),
      ).toBeNull();
      await truncate(file, 33 * 1024 * 1024);
      expect(await readClaudeRewindHistory({ ...input, configDir: temp })).toBeNull();
      await rm(file);
      const other = Path.join(temp, "unrelated.jsonl");
      await writeFile(other, encode(messages));
      await symlink(other, file);
      expect(await readClaudeRewindHistory({ ...input, configDir: temp })).toBeNull();
      await rm(projectDir, { recursive: true });
      await mkdir(Path.join(temp, "elsewhere"));
      await symlink(Path.join(temp, "elsewhere"), projectDir);
      expect(await readClaudeRewindHistory({ ...input, configDir: temp })).toBeNull();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
