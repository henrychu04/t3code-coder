import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS } from "./settingsSearch";

describe("settings search catalog", () => {
  it("uses unique action ids", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes individual GitLab, sidebar, editor, and appearance controls", () => {
    const ids = new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.id));
    for (const id of [
      "git-fetch-interval",
      "source-control-writing-style",
      "follow-merge-request-templates",
      "gitlab-write-probe",
      "default-checkout-mode",
      "auto-settle-inactive-threads",
      "diff-layout",
      "confirm-thread-delete",
      "color-mode",
      "interface-font",
      "terminal-font",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("provides searchable context beyond the visible title", () => {
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(item.section.length).toBeGreaterThan(0);
      expect(item.searchTerms.some((term) => term.trim().length > 0)).toBe(true);
    }
  });
});
