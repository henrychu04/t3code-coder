import { describe, expect, it } from "@effect/vitest";

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

  it("enforces the aggregate 64 MiB UTF-8 budget and rejects an oversized snapshot", () => {
    const retention = makeThreadSnapshotRetention<string>();
    const first = { snapshot: "a".repeat(32 * 1024 * 1024) as string | undefined };
    retention.retain(first);
    const second = { snapshot: "é".repeat(16 * 1024 * 1024) as string | undefined };
    retention.retain(second);
    // Each JSON string also includes quotes, so the combined size exceeds 64 MiB.
    expect(first.snapshot).toBeUndefined();
    expect(second.snapshot).toBeDefined();
    const oversized = { snapshot: "a".repeat(64 * 1024 * 1024) as string | undefined };
    retention.retain(oversized);
    expect(oversized.snapshot).toBeUndefined();
    expect(second.snapshot).toBeDefined();
  });
});
