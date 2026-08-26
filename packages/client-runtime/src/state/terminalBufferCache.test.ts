import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { TerminalBufferCache } from "./terminalBufferCache.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

const input = (threadId: string, terminalId = "terminal-1") => ({
  threadId: ThreadId.make(threadId),
  terminalId,
});

const state = (buffer: string, sequence: number): TerminalBufferState => ({
  ...EMPTY_TERMINAL_BUFFER_STATE,
  buffer,
  sequence,
});

describe("TerminalBufferCache", () => {
  it("isolates entries by environment, thread, and terminal", () => {
    const cache = new TerminalBufferCache(1_024, 10);
    cache.write("environment-a", input("thread-a"), state("a", 1));
    cache.write("environment-b", input("thread-a"), state("b", 2));
    cache.write("environment-a", input("thread-b"), state("c", 3));
    cache.write("environment-a", input("thread-a", "terminal-2"), state("d", 4));

    expect(cache.read("environment-a", input("thread-a")).buffer).toBe("a");
    expect(cache.read("environment-b", input("thread-a")).buffer).toBe("b");
    expect(cache.read("environment-a", input("thread-b")).buffer).toBe("c");
    expect(cache.read("environment-a", input("thread-a", "terminal-2")).buffer).toBe("d");
  });

  it("evicts least-recently-used entries by count", () => {
    const cache = new TerminalBufferCache(1_024, 2);
    cache.write("environment", input("thread-a"), state("a", 1));
    cache.write("environment", input("thread-b"), state("b", 2));
    cache.read("environment", input("thread-a"));
    cache.write("environment", input("thread-c"), state("c", 3));

    expect(cache.read("environment", input("thread-a")).buffer).toBe("a");
    expect(cache.read("environment", input("thread-b"))).toBe(EMPTY_TERMINAL_BUFFER_STATE);
    expect(cache.read("environment", input("thread-c")).buffer).toBe("c");
  });

  it("accounts in UTF-8 bytes, handles replacement, and skips oversized entries", () => {
    const cache = new TerminalBufferCache(4, 10);
    cache.write("environment", input("thread-a"), state("🙂", 1));
    cache.write("environment", input("thread-a"), state("a", 2));
    cache.write("environment", input("thread-b"), state("bcd", 3));

    expect(cache.read("environment", input("thread-a")).buffer).toBe("a");
    expect(cache.read("environment", input("thread-b")).buffer).toBe("bcd");

    cache.write("environment", input("thread-c"), state("🙂x", 4));
    expect(cache.read("environment", input("thread-c"))).toBe(EMPTY_TERMINAL_BUFFER_STATE);
    expect(cache.read("environment", input("thread-a")).buffer).toBe("a");
  });

  it("stores nothing when configured with zero capacity", () => {
    const cache = new TerminalBufferCache(10, 0);
    cache.write("environment", input("thread-a"), state("a", 1));
    expect(cache.read("environment", input("thread-a"))).toBe(EMPTY_TERMINAL_BUFFER_STATE);
  });
});
