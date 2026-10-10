// @effect-diagnostics nodeBuiltinImport:off -- Coder: a private local-file transport, no listener.
/**
 * Coder: the transport that carries T3 tool calls to agents without MCP or a socket.
 *
 * Each credential gets a private temporary directory holding a standalone Node CLI and a
 * read-only tool catalog. The CLI writes one request per call into its own `calls/<id>/`
 * directory; the helper polls, runs the tool, and publishes one reply. Workspace processes run
 * as the same OS user, so these directories are not an isolation boundary between mutually
 * untrusted agents.
 *
 * @module mcp/bridge/FileBridge
 */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Data from "effect/Data";

import { clientSource } from "./clientSource.ts";

const MAX_BRIDGE_REQUEST_BYTES = 256 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 256 * 1024;
/** Tool calls run concurrently; more waiting calls queue in their directories. */
const MAX_CONCURRENT_CALLS = 8;
const CALL_ID_PATTERN = /^[a-f0-9-]{36}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export interface FileBridgeRequest {
  readonly id: string;
  readonly tool: string;
  readonly params: unknown;
}

export interface FileBridgeCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: unknown;
}

/** A tool's own failure, reported to the agent as structured output. */
export class FileBridgeToolFailure extends Data.TaggedError("FileBridgeToolFailure")<{
  readonly value: unknown;
}> {}

export function parseFileBridgeRequest(value: unknown): FileBridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid T3 tool call.");
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some((key) => !["id", "tool", "params"].includes(key)) ||
    typeof request.id !== "string" ||
    !CALL_ID_PATTERN.test(request.id) ||
    typeof request.tool !== "string" ||
    !TOOL_NAME_PATTERN.test(request.tool) ||
    request.params === null ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  ) {
    throw new Error("Invalid T3 tool call.");
  }
  return request as unknown as FileBridgeRequest;
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? undefined : buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

export interface FileBridge {
  readonly directory: string;
  readonly script: string;
  readonly close: () => Promise<void>;
}

export async function createFileBridge(
  handler: (request: FileBridgeRequest, signal: AbortSignal) => Promise<unknown>,
  options: {
    readonly catalog: ReadonlyArray<FileBridgeCatalogEntry>;
    readonly parent?: string;
    readonly intervalMs?: number;
    /** Safety net only: the dispatcher answers long tools with a task id well before this. */
    readonly timeoutMs?: number;
  },
): Promise<FileBridge> {
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), "t3-tools-"));
  const script = join(directory, "t3.mjs");
  const calls = join(directory, "calls");
  try {
    await writeFile(script, clientSource, { mode: 0o600 });
    await writeFile(join(directory, "tools.json"), JSON.stringify(options.catalog), {
      mode: 0o600,
    });
    await mkdir(calls, { mode: 0o700 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  const controllers = new Set<AbortController>();
  const active = new Map<string, Promise<void>>();

  const serveCall = async (callId: string) => {
    const call = join(calls, callId);
    let request: FileBridgeRequest;
    try {
      const stat = await lstat(call);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const text = await readBounded(join(call, "request.json"), MAX_BRIDGE_REQUEST_BYTES);
      if (text === undefined) return;
      request = parseFileBridgeRequest(JSON.parse(text));
      if (request.id !== callId) return;
      await rename(join(call, "request.json"), join(call, "processing.json"));
    } catch {
      // No request yet, malformed input, or the caller left. Never log contents or paths.
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    let response: object;
    try {
      const value = await Promise.race([
        handler(request, controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("T3 tool call expired.")),
            { once: true },
          ),
        ),
      ]);
      response = { id: request.id, ok: true, value };
    } catch (error) {
      response =
        error instanceof FileBridgeToolFailure
          ? { id: request.id, ok: false, value: error.value }
          : {
              id: request.id,
              ok: false,
              error:
                error instanceof Error && error.message.startsWith("T3 tool")
                  ? error.message
                  : "T3 tool call failed or expired.",
            };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
    if (closed) return;
    let encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded) > MAX_BRIDGE_RESPONSE_BYTES) {
      encoded = JSON.stringify({
        id: request.id,
        ok: false,
        error: "T3 tool result exceeds 256 KiB. Request a smaller page.",
      });
    }
    try {
      // The caller may have given up and removed its directory. Never publish elsewhere.
      const processing = await readBounded(join(call, "processing.json"), MAX_BRIDGE_REQUEST_BYTES);
      if (processing === undefined || JSON.parse(processing).id !== request.id) return;
      const out = await open(join(call, "reply.json"), "wx", 0o600);
      try {
        await out.writeFile(encoded);
      } finally {
        await out.close();
      }
      await rename(join(call, "reply.json"), join(call, "response.json"));
    } catch {
      // The caller disappeared.
    }
  };

  const tick = async () => {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(calls);
    } catch {
      return;
    }
    for (const callId of entries) {
      if (active.size >= MAX_CONCURRENT_CALLS) return;
      if (!CALL_ID_PATTERN.test(callId) || active.has(callId)) continue;
      active.set(
        callId,
        serveCall(callId).finally(() => active.delete(callId)),
      );
    }
  };
  let ticking: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (closed || ticking) return;
    ticking = tick().finally(() => {
      ticking = undefined;
    });
  }, options.intervalMs ?? 100);
  timer.unref();
  return {
    directory,
    script,
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      await ticking;
      await Promise.allSettled(active.values());
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
