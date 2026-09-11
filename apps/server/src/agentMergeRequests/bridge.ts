import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientSource } from "./clientSource.ts";

export interface AgentMrRequest {
  readonly id: string;
  readonly operation: "list" | "link" | "unlink";
  readonly url?: string;
}
export function parseAgentMrRequest(value: unknown): AgentMrRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid MR command.");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["id", "operation", "url"].includes(key)) ||
    typeof v.id !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.id) ||
    !["list", "link", "unlink"].includes(String(v.operation)) ||
    (v.operation === "list"
      ? v.url !== undefined
      : typeof v.url !== "string" || v.url.length > 8192)
  )
    throw new Error("Invalid MR command.");
  return v as unknown as AgentMrRequest;
}

/** Local files only: no socket, provider configuration, or direct database writes. */
export async function createAgentMrBridge(
  handler: (request: AgentMrRequest, signal: AbortSignal) => Promise<unknown>,
  options: {
    readonly parent?: string;
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
  } = {},
) {
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), "t3-agent-mrs-"));
  const script = join(directory, "mr.mjs");
  try {
    await writeFile(script, clientSource, { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const call = join(directory, "call");
  const tick = async () => {
    let request: AgentMrRequest | undefined;
    try {
      if (!(await lstat(call)).isDirectory() || (await lstat(call)).isSymbolicLink()) return;
      const file = await open(
        join(call, "request.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 16384) return;
        const buffer = Buffer.alloc(16385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16384) return;
        request = parseAgentMrRequest(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
      } finally {
        await file.close();
      }
      await rename(join(call, "request.json"), join(call, "processing.json"));
      controller = new AbortController();
      const activeController = controller;
      const timeout = setTimeout(() => activeController.abort(), options.timeoutMs ?? 10000);
      let response: object;
      try {
        const value = await Promise.race([
          handler(request, activeController.signal),
          new Promise<never>((_, reject) =>
            activeController.signal.addEventListener(
              "abort",
              () => reject(new Error("MR command expired.")),
              { once: true },
            ),
          ),
        ]);
        response = { id: request.id, ok: true, value };
      } catch {
        response = {
          id: request.id,
          ok: false,
          error:
            "MR command failed or expired. Check the GitLab URL and active thread, then list links before retrying.",
        };
      } finally {
        clearTimeout(timeout);
      }
      if (closed) return;
      const encoded = JSON.stringify(response);
      if (Buffer.byteLength(encoded) > 262144) return;
      // A timed-out caller may already have started another invocation. Never publish into it.
      const processing = await open(
        join(call, "processing.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await processing.stat();
        if (!stat.isFile() || stat.size > 16384) return;
        const buffer = Buffer.alloc(16385);
        const { bytesRead } = await processing.read(buffer, 0, buffer.length, 0);
        if (
          bytesRead > 16384 ||
          JSON.parse(buffer.toString("utf8", 0, bytesRead)).id !== request.id
        )
          return;
      } finally {
        await processing.close();
      }
      const out = await open(join(call, "reply.json"), "wx", 0o600);
      try {
        await out.writeFile(encoded);
      } finally {
        await out.close();
      }
      await rename(join(call, "reply.json"), join(call, "response.json"));
    } catch {
      // No request, malformed input, or caller disappeared. Never log request contents or paths.
    }
  };
  const timer = setInterval(() => {
    if (closed || inFlight) return;
    inFlight = tick().finally(() => {
      inFlight = undefined;
    });
  }, options.intervalMs ?? 250);
  timer.unref();
  return {
    directory,
    script,
    close: async () => {
      closed = true;
      clearInterval(timer);
      controller?.abort();
      await inFlight;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
