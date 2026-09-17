import { describe, expect, it, vi } from "@effect/vitest";

import { makeThreadSnapshotRetention } from "./threadRetention.ts";

describe("idle thread snapshot limits", () => {
  it("evicts the least recently used idle snapshot after 24 entries", () => {
    const retention = makeThreadSnapshotRetention<string>();
    const entries = Array.from({ length: 25 }, (_, index) => ({
      snapshot: String(index) as string | undefined,
    }));
    for (const entry of entries.slice(0, 24)) retention.retain(entry);
    retention.release(entries[0]!);
    retention.retain(entries[0]!);
    retention.retain(entries[24]!);

    expect(entries[0]!.snapshot).toBe("0");
    expect(entries[1]!.snapshot).toBeUndefined();
    expect(entries[24]!.snapshot).toBe("24");
  });

  it("excludes active snapshots from eviction and releases expired entries", () => {
    const retention = makeThreadSnapshotRetention<string>();
    const active = { snapshot: "active" as string | undefined };
    retention.retain(active);
    retention.release(active);
    const idle = { snapshot: "idle" as string | undefined };
    retention.retain(idle);
    const expired = { snapshot: "expired" as string | undefined };
    retention.retain(expired);
    retention.release(expired);
    for (let index = 0; index < 23; index++) retention.retain({ snapshot: String(index) });

    expect(active.snapshot).toBe("active");
    expect(idle.snapshot).toBe("idle");
  });

  it("enforces the aggregate 64 MiB estimate and rejects an oversized snapshot", () => {
    const retention = makeThreadSnapshotRetention<string>();
    const first = { snapshot: "a".repeat(6 * 1024 * 1024) as string | undefined };
    retention.retain(first);
    expect(first.snapshot).toBeDefined();
    const second = { snapshot: "é".repeat(6 * 1024 * 1024) as string | undefined };
    retention.retain(second);
    // Each string is conservatively charged six bytes per UTF-16 code unit.
    expect(first.snapshot).toBeUndefined();
    expect(second.snapshot).toBeDefined();
    const oversized = { snapshot: "a".repeat(64 * 1024 * 1024) as string | undefined };
    retention.retain(oversized);
    expect(oversized.snapshot).toBeUndefined();
    expect(second.snapshot).toBeDefined();
  });

  it("does not serialize or encode large message bodies when a thread becomes idle", () => {
    const retention = makeThreadSnapshotRetention<object>();
    const stringify = vi.spyOn(JSON, "stringify");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const retained = { snapshot: { messages: [{ text: "x".repeat(8 * 1024 * 1024) }] } };
      const oversized = { snapshot: { messages: [{ text: "x".repeat(32 * 1024 * 1024) }] } };
      retention.retain(retained);
      retention.retain(oversized);
      expect(retained.snapshot).toBeDefined();
      expect(oversized.snapshot).toBeUndefined();
      expect(stringify).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      encode.mockRestore();
    }
  });

  it("drops excessively wide or deep snapshots without exhausting the call stack", () => {
    const retention = makeThreadSnapshotRetention<unknown>();
    const wide = { snapshot: Array.from({ length: 8_193 }, () => 0) as unknown };
    let nested: unknown = "leaf";
    for (let index = 0; index < 100; index++) nested = [nested];
    const deep = { snapshot: nested };
    retention.retain(wide);
    retention.retain(deep);
    expect(wide.snapshot).toBeUndefined();
    expect(deep.snapshot).toBeUndefined();
    const next = { snapshot: "small" };
    retention.retain(next);
    expect(next.snapshot).toBe("small");
  });
});
