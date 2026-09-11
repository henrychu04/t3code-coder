import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { createAgentMrBridge, parseAgentMrRequest } from "./bridge.ts";

const exec = promisify(execFile);
const id = "00000000-0000-4000-8000-000000000000";
describe("workspace agent MR bridge", () => {
  it("runs the standalone CLI without a listener and removes its files", async () => {
    const requests: unknown[] = [];
    const bridge = await createAgentMrBridge(
      async (request) => {
        requests.push(request);
        return { mergeRequests: [] };
      },
      { intervalMs: 5 },
    );
    try {
      const result = await exec(process.execPath, [bridge.script, "list"]);
      expect(JSON.parse(result.stdout)).toEqual({ mergeRequests: [] });
      expect(requests).toEqual([{ id: expect.any(String), operation: "list" }]);
      await expect(access(join(bridge.directory, "call"))).rejects.toThrow();
    } finally {
      await bridge.close();
    }
    await expect(access(bridge.directory)).rejects.toThrow();
  });
  it("accepts a URL as one argument and sanitizes backend failures", async () => {
    const bridge = await createAgentMrBridge(
      async () => {
        throw new Error("private backend details");
      },
      { intervalMs: 5 },
    );
    try {
      await expect(
        exec(process.execPath, [
          bridge.script,
          "link",
          "https://gitlab.com/team/repo/-/merge_requests/1",
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("MR command failed or expired") });
    } finally {
      await bridge.close();
    }
  });
  it("times out and aborts a blocked handler", async () => {
    let aborted = false;
    const bridge = await createAgentMrBridge(
      async (_, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      { intervalMs: 5, timeoutMs: 25 },
    );
    try {
      await expect(exec(process.execPath, [bridge.script, "list"])).rejects.toMatchObject({
        stderr: expect.stringContaining("MR command failed or expired"),
      });
      expect(aborted).toBe(true);
    } finally {
      await bridge.close();
    }
  });
  it("rejects extra fields, thread overrides, malformed IDs and oversized URLs", () => {
    for (const request of [
      { id, operation: "list", threadId: "another-thread" },
      { id, operation: "list", url: "https://gitlab.com" },
      { id: "../escape", operation: "list" },
      { id, operation: "link", url: "x".repeat(8193) },
      { id, operation: "delete" },
    ])
      expect(() => parseAgentMrRequest(request)).toThrow();
  });
  it("does not read symlinked or oversized requests", async () => {
    let calls = 0;
    const bridge = await createAgentMrBridge(
      async () => {
        calls++;
      },
      { intervalMs: 5 },
    );
    const external = await mkdtemp(join(tmpdir(), "t3-mr-test-"));
    try {
      const call = join(bridge.directory, "call");
      await mkdir(call);
      const target = join(external, "request.json");
      await writeFile(target, JSON.stringify({ id, operation: "list" }));
      await symlink(target, join(call, "request.json"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
      expect(await readFile(target, "utf8")).toContain(id);
      await rm(join(call, "request.json"));
      await writeFile(join(call, "request.json"), " ".repeat(16385));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
    } finally {
      await bridge.close();
      await rm(external, { recursive: true, force: true });
    }
  });
});
