import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

// Coder: upstream's Usage cases are cut with the usage item; these keep its override checks.
const automations = THREAD_DETAILS_ITEMS.find((item) => item.id === "automations")!;

describe("thread details items", () => {
  it("resolves items from overrides, ignoring retired ids", () => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: { automations: false, usage: true },
    });
    expect(visibility.automations).toBe(false);
    expect(visibility.lineage).toBe(true);
    expect("usage" in visibility).toBe(false);
    expect(visibility.context).toBe(false);
  });

  it("stores only choices that differ from the default", () => {
    const hidden = { threadDetailsItems: { automations: false } };
    expect(setThreadDetailsItem(hidden, automations, true)).toEqual({});
    expect(setThreadDetailsItem({ threadDetailsItems: {} }, automations, false)).toEqual({
      automations: false,
    });
  });
});
