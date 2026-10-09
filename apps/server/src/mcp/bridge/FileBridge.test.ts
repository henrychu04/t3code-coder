import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

import { createFileBridge, FileBridgeToolFailure, parseFileBridgeRequest } from "./FileBridge.ts";

const exec = promisify(execFile);
const id = "00000000-0000-4000-8000-000000000000";
const catalog = [
  {
    name: "list_things",
    description: "Lists things.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
  },
];

describe("T3 tool file bridge", () => {
  it("runs the standalone CLI without a listener and removes its files", async () => {
    const requests: unknown[] = [];
    const bridge = await createFileBridge(
      async (request) => {
        requests.push(request);
        return { things: [] };
      },
      { catalog, intervalMs: 5 },
    );
    try {
      const result = await exec(process.execPath, [bridge.script, "list_things", '{"a":1}']);
      expect(JSON.parse(result.stdout)).toEqual({ things: [] });
      expect(requests).toEqual([{ id: expect.any(String), tool: "list_things", params: { a: 1 } }]);
      expect(await exec(process.execPath, [bridge.script, "list_things"])).toMatchObject({
        stdout: '{"things":[]}\n',
      });
    } finally {
      await bridge.close();
    }
    await expect(access(bridge.directory)).rejects.toThrow();
  });

  it("serves the catalog locally and reads parameters from stdin", async () => {
    const requests: unknown[] = [];
    const bridge = await createFileBridge(
      async (request) => {
        requests.push(request);
        return "ok";
      },
      { catalog, intervalMs: 5 },
    );
    try {
      expect((await exec(process.execPath, [bridge.script, "--list"])).stdout).toBe(
        "list_things (read-only): Lists things.\n",
      );
      expect(
        JSON.parse(
          (await exec(process.execPath, [bridge.script, "--schema", "list_things"])).stdout,
        ),
      ).toEqual(catalog[0]!.inputSchema);
      const child = spawn(process.execPath, [bridge.script, "list_things", "-"]);
      child.stdin.end(JSON.stringify({ prompt: "x".repeat(200_000) }));
      const exitCode = await new Promise((resolve) => child.on("exit", resolve));
      expect(exitCode).toBe(0);
      expect(requests).toEqual([
        { id: expect.any(String), tool: "list_things", params: { prompt: "x".repeat(200_000) } },
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("serves concurrent calls", async () => {
    const release = Promise.withResolvers<void>();
    let started = 0;
    const bridge = await createFileBridge(
      async () => {
        started += 1;
        if (started === 2) release.resolve();
        await release.promise;
        return started;
      },
      { catalog, intervalMs: 5 },
    );
    try {
      await Promise.all([
        exec(process.execPath, [bridge.script, "list_things"]),
        exec(process.execPath, [bridge.script, "list_things"]),
      ]);
      expect(started).toBe(2);
    } finally {
      await bridge.close();
    }
  });

  it("prints tool failures as output and sanitizes unexpected errors", async () => {
    const bridge = await createFileBridge(
      async (request) => {
        if (request.tool === "list_things") {
          throw new FileBridgeToolFailure({ value: { _tag: "ThingMissing" } });
        }
        throw new Error("private backend details");
      },
      { catalog, intervalMs: 5 },
    );
    try {
      await expect(exec(process.execPath, [bridge.script, "list_things"])).rejects.toMatchObject({
        stdout: '{"_tag":"ThingMissing"}\n',
      });
      const failure = exec(process.execPath, [bridge.script, "other_tool"]);
      await expect(failure).rejects.toMatchObject({
        stderr: "T3 tool call failed or expired.\n",
      });
    } finally {
      await bridge.close();
    }
  });

  it("times out and aborts a blocked handler", async () => {
    let aborted = false;
    const bridge = await createFileBridge(
      async (_, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      { catalog, intervalMs: 5, timeoutMs: 25 },
    );
    try {
      await expect(exec(process.execPath, [bridge.script, "list_things"])).rejects.toMatchObject({
        stderr: expect.stringContaining("T3 tool call expired"),
      });
      expect(aborted).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it("rejects extra fields, malformed ids and tool names, and non-object parameters", () => {
    for (const request of [
      { id, tool: "list_things", params: {}, threadId: "another-thread" },
      { id: "../escape", tool: "list_things", params: {} },
      { id, tool: "../escape", params: {} },
      { id, tool: "List", params: {} },
      { id, tool: "list_things", params: [] },
      { id, tool: "list_things" },
    ])
      expect(() => parseFileBridgeRequest(request)).toThrow();
  });

  it("does not read symlinked or oversized requests", async () => {
    let calls = 0;
    const bridge = await createFileBridge(
      async () => {
        calls++;
      },
      { catalog, intervalMs: 5 },
    );
    const external = await mkdtemp(join(tmpdir(), "t3-tools-test-"));
    try {
      const call = join(bridge.directory, "calls", id);
      await mkdir(call);
      const target = join(external, "request.json");
      await writeFile(target, JSON.stringify({ id, tool: "list_things", params: {} }));
      await symlink(target, join(call, "request.json"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
      expect(await readFile(target, "utf8")).toContain(id);
      await rm(join(call, "request.json"));
      await writeFile(join(call, "request.json"), " ".repeat(256 * 1024 + 1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
    } finally {
      await bridge.close();
      await rm(external, { recursive: true, force: true });
    }
  });
});
